import { Effect } from "effect";
import { commandError } from "../errors";
import { GitHubService } from "./github-service";
import type {
  ExplicitPrAssociation,
  PrDiscoverySnapshot,
  WorkspacePrEntry,
} from "./pr-cache-service";
import { fetchPrDetails } from "./pr-details";
import {
  normalizeGhPr,
  type PushDestination,
  resolveWorkspacePr,
} from "./pr-discovery";
import { type PrFacts, prIdentity } from "./pr-model";

export interface PrRefreshWorkspace {
  branch: string;
  destination: PushDestination | null;
  explicit: ExplicitPrAssociation | null;
  cached: WorkspacePrEntry | null;
}

/** Only a complete list replaces discovery; association failures are independent. */
export function refreshPrDiscovery(
  cwd: string,
  baseRepository: string,
  previous: PrDiscoverySnapshot | null,
) {
  return GitHubService.use((github) =>
    Effect.gen(function* () {
      const cached =
        previous?.baseRepository.toLowerCase() === baseRepository.toLowerCase()
          ? previous
          : null;
      const raw = yield* github.listRawPrs(
        cwd,
        cached ? "open" : "all",
        baseRepository,
      );
      const now = Date.now();
      const fresh: PrFacts[] = [];
      for (const value of raw) {
        const pr = normalizeGhPr(value, baseRepository, now);
        if (!pr)
          return yield* commandError(
            "pr_error",
            "Incomplete PR discovery data",
          );
        fresh.push(pr);
      }
      const pool = new Map(
        (cached?.prs ?? []).map((pr) => [prIdentity(pr), pr]),
      );
      for (const pr of fresh) pool.set(prIdentity(pr), pr);
      return {
        baseRepository,
        prs: [...pool.values()],
        explicitPrs: cached?.explicitPrs ?? [],
        openNumbers: fresh
          .filter((pr) => pr.state === "OPEN")
          .map((pr) => pr.number),
        fetchedAt: now,
      } satisfies PrDiscoverySnapshot;
    }),
  );
}

function branchIndex(prs: Iterable<PrFacts>) {
  const index = new Map<string, PrFacts[]>();
  for (const pr of prs) {
    const group = index.get(pr.headRefName) ?? [];
    group.push(pr);
    index.set(pr.headRefName, group);
  }
  return index;
}
function matching(
  index: Map<string, PrFacts[]>,
  workspace: PrRefreshWorkspace,
) {
  const destination = workspace.destination;
  const branch = index.get(destination?.branch ?? workspace.branch) ?? [];
  return destination
    ? branch.filter(
        (pr) =>
          pr.headRepository?.toLowerCase() ===
          destination.repository.toLowerCase(),
      )
    : branch;
}

/** Refresh live identities in batches; terminal candidates retain cached facts. */
export function refreshWorkspacePrs(
  cwd: string,
  snapshot: PrDiscoverySnapshot,
  workspaces: readonly PrRefreshWorkspace[],
  force: boolean,
  reuseFresh = false,
) {
  return GitHubService.use((github) =>
    Effect.gen(function* () {
      const pool = new Map(snapshot.prs.map((pr) => [prIdentity(pr), pr]));
      const external = new Map(
        snapshot.explicitPrs.map((pr) => [prIdentity(pr), pr]),
      );
      const index = branchIndex(pool.values());
      const open = new Set(snapshot.openNumbers);
      const needed = new Map<string, ExplicitPrAssociation>();
      const failed = new Map<string, string>();
      for (const workspace of workspaces) {
        for (const pr of matching(index, workspace))
          if (pr.state === "OPEN" && !open.has(pr.number))
            needed.set(prIdentity(pr), pr);
        if (workspace.explicit) {
          const identity = prIdentity(workspace.explicit);
          const known = pool.get(identity) ?? external.get(identity);
          const local =
            workspace.explicit.baseRepository.toLowerCase() ===
            snapshot.baseRepository.toLowerCase();
          if (
            !known ||
            (!local && (force || (!reuseFresh && known.state !== "MERGED"))) ||
            (known.state === "OPEN" && local && !open.has(known.number))
          )
            needed.set(identity, workspace.explicit);
        }
      }
      const groups = new Map<string, ExplicitPrAssociation[]>();
      for (const identity of needed.values()) {
        const repository = identity.baseRepository.toLowerCase();
        const group = groups.get(repository) ?? [];
        group.push(identity);
        groups.set(repository, group);
      }
      yield* Effect.forEach(
        [...groups],
        ([repository, identities]) =>
          Effect.gen(function* () {
            const results = yield* github
              .getRawPrs(
                cwd,
                repository,
                identities.map((pr) => pr.number),
              )
              .pipe(
                Effect.catch((error) =>
                  Effect.succeed(
                    identities.map((pr) => ({
                      number: pr.number,
                      raw: null,
                      error: error.message,
                    })),
                  ),
                ),
              );
            for (const identity of identities) {
              const result = results.find(
                (result) => result.number === identity.number,
              );
              const pr = normalizeGhPr(result?.raw, repository, Date.now());
              if (
                result?.error ||
                !pr ||
                prIdentity(pr) !== prIdentity(identity)
              ) {
                failed.set(
                  prIdentity(identity),
                  result?.error ?? "Incomplete associated PR data",
                );
                continue;
              }
              if (repository === snapshot.baseRepository.toLowerCase())
                pool.set(prIdentity(pr), pr);
              else external.set(prIdentity(pr), pr);
            }
          }),
        { concurrency: 4 },
      );
      const currentIndex = branchIndex(pool.values());
      const entries = new Map<string, WorkspacePrEntry>();
      for (const workspace of workspaces) {
        const explicitPr = workspace.explicit
          ? (pool.get(prIdentity(workspace.explicit)) ??
            external.get(prIdentity(workspace.explicit)) ??
            null)
          : null;
        const entry = resolveWorkspacePr(
          matching(currentIndex, workspace),
          workspace.branch,
          workspace.destination,
          workspace.explicit,
          Date.now(),
          explicitPr,
        );
        if (workspace.explicit && failed.has(prIdentity(workspace.explicit)))
          entry.lastError = failed.get(prIdentity(workspace.explicit)) ?? null;
        if (entry.pr && failed.has(prIdentity(entry.pr)))
          entry.lastError = failed.get(prIdentity(entry.pr)) ?? null;
        entry.candidates = entry.candidates.map((pr) => ({
          ...pr,
          lastError: failed.get(prIdentity(pr)) ?? pr.lastError,
        }));
        // Terminal check facts are reused only for the same PR and head.
        const cachedPr = workspace.cached?.pr;
        if (
          !force &&
          entry.pr &&
          entry.pr.state !== "OPEN" &&
          cachedPr &&
          prIdentity(entry.pr) === prIdentity(cachedPr) &&
          entry.pr.state === cachedPr.state &&
          entry.pr.headOid === cachedPr.headOid &&
          cachedPr.checksComplete
        )
          entry.pr = {
            ...entry.pr,
            checks: cachedPr.checks,
            checksComplete: true,
            isQueued: cachedPr.isQueued,
            isMergeQueueEnabled: cachedPr.isMergeQueueEnabled,
          };
        entries.set(workspace.branch, entry);
      }
      const detailTargets = new Map<string, PrFacts>();
      for (const entry of entries.values()) {
        for (const pr of [entry.pr, ...entry.candidates])
          if (
            pr &&
            !failed.has(prIdentity(pr)) &&
            ((pr.state === "OPEN" && (!reuseFresh || !pr.checksComplete)) ||
              (pr === entry.pr && (force || !pr.checksComplete)))
          )
            detailTargets.set(prIdentity(pr), pr);
      }
      const byBase = new Map<string, PrFacts[]>();
      for (const pr of detailTargets.values()) {
        const group = byBase.get(pr.baseRepository) ?? [];
        group.push(pr);
        byBase.set(pr.baseRepository, group);
      }
      const details = new Map(
        (yield* Effect.forEach(
          [...byBase],
          ([repository, prs]) => fetchPrDetails(cwd, repository, prs),
          { concurrency: 4 },
        ))
          .flat()
          .map((pr) => [prIdentity(pr), pr]),
      );
      for (const pr of details.values()) {
        if (pr.lastError || !pr.checksComplete) continue;
        if (
          pr.baseRepository.toLowerCase() ===
          snapshot.baseRepository.toLowerCase()
        )
          pool.set(prIdentity(pr), pr);
        else external.set(prIdentity(pr), pr);
      }
      for (const workspace of workspaces) {
        const entry = entries.get(workspace.branch);
        if (!entry) continue;
        if (entry.pr) {
          const fresh = details.get(prIdentity(entry.pr)) ?? entry.pr;
          if (fresh.lastError || failed.has(prIdentity(fresh))) {
            entry.lastError ??=
              fresh.lastError ?? failed.get(prIdentity(fresh)) ?? null;
            const cachedPr = workspace.cached?.pr;
            entry.pr =
              cachedPr &&
              prIdentity(cachedPr) === prIdentity(fresh) &&
              cachedPr.checksComplete
                ? cachedPr
                : null;
            if (!entry.pr) entry.uncertain = true;
          } else entry.pr = fresh;
        }
        entry.candidates = entry.candidates.map(
          (pr) => details.get(prIdentity(pr)) ?? pr,
        );
        if (!entry.pr && !entry.explicit)
          entry.lastError ??=
            entry.candidates.find((pr) => pr.state === "OPEN" && pr.lastError)
              ?.lastError ?? null;
      }
      return {
        entries,
        snapshot: {
          ...snapshot,
          prs: [...pool.values()],
          explicitPrs: [...external.values()],
        },
      };
    }),
  );
}

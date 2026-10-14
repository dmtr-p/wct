import { Effect } from "effect";
import { commandError } from "../errors";
import { GitHubService } from "./github-service";
import type { ExplicitPrAssociation } from "./pr-cache-service";
import {
  normalizeGhPr,
  type PushDestination,
  resolveWorkspacePr,
} from "./pr-discovery";
import { type PrFacts, prIdentity } from "./pr-model";

export interface PrDiscoverySnapshot {
  baseRepository: string;
  prs: PrFacts[];
}

export interface PrRefreshWorkspace {
  branch: string;
  destination: PushDestination | null;
  explicit: ExplicitPrAssociation | null;
}

/** A null snapshot requests complete discovery, including historical PRs. */
export function refreshPrDiscovery(
  cwd: string,
  baseRepository: string,
  workspaces: readonly PrRefreshWorkspace[],
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
      const fetched = new Set(fresh.map(prIdentity));
      const needed = new Map<string, ExplicitPrAssociation>();
      const explicitPrs = new Map<string, PrFacts>();
      for (const workspace of workspaces) {
        const entry = resolveWorkspacePr(
          [...pool.values()],
          workspace.branch,
          workspace.destination,
          workspace.explicit,
          now,
        );
        for (const pr of [entry.pr, ...entry.candidates]) {
          if (pr && !fetched.has(prIdentity(pr)))
            needed.set(prIdentity(pr), pr);
        }
        if (workspace.explicit && !fetched.has(prIdentity(workspace.explicit)))
          needed.set(prIdentity(workspace.explicit), workspace.explicit);
      }
      // Refresh only historical/missing identities relevant to active Workspaces.
      // This also observes known open PRs that closed between polls.
      for (const identity of needed.values()) {
        const value = yield* github.getRawPr(
          cwd,
          identity.baseRepository,
          identity.number,
        );
        const pr = normalizeGhPr(value, identity.baseRepository, now);
        if (!pr || prIdentity(pr) !== prIdentity(identity))
          return yield* commandError(
            "pr_error",
            "Incomplete associated PR data",
          );
        if (pr.baseRepository.toLowerCase() === baseRepository.toLowerCase())
          pool.set(prIdentity(pr), pr);
        else explicitPrs.set(prIdentity(pr), pr);
      }
      return {
        snapshot: { baseRepository, prs: [...pool.values()] },
        open: fresh.filter((pr) => pr.state === "OPEN"),
        explicitPrs,
        fetchedAt: now,
      };
    }),
  );
}

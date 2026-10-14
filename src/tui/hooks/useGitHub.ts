import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitHubService } from "../../services/github-service";
import {
  PrCacheService,
  type WorkspacePrEntry,
} from "../../services/pr-cache-service";
import { fetchPrDetails } from "../../services/pr-details";
import {
  resolvePushDestination,
  resolveWorkspacePr,
} from "../../services/pr-discovery";
import {
  checkSummary,
  type PrFacts,
  prIdentity,
} from "../../services/pr-model";
import {
  type PrDiscoverySnapshot,
  refreshPrDiscovery,
} from "../../services/pr-refresh";
import { workspaceIdentityKey } from "../lifecycle";
import { tuiRuntime } from "../runtime";
import type { PRInfo } from "../types";
import type { RepoInfo } from "./useRegistry";

const GITHUB_POLL_INTERVAL = 120_000;
const DISCOVERY_RETRY_DELAY = 600_000;

function worktreeSignature(repo: RepoInfo) {
  return JSON.stringify([
    repo.error,
    repo.worktrees.map((wt) => [wt.branch, wt.path, wt.isMainWorktree]),
  ]);
}
export function displayPr(pr: PrFacts): PRInfo {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    headRefName: pr.headRefName,
    rollupState: checkSummary(pr.checks, pr.checksComplete),
    facts: pr,
  };
}

function hydrate(repos: RepoInfo[]) {
  const associations = new Map<string, WorkspacePrEntry>();
  const openPrs = new Map<string, PRInfo[]>();
  for (const repo of repos) {
    try {
      const open = tuiRuntime.runSync(
        PrCacheService.use((s) => s.getOpenPrs(repo.repoPath)),
      );
      if (open)
        openPrs.set(
          repo.repoPath,
          open.payload.filter((pr) => pr.state === "OPEN"),
        );
      for (const wt of repo.worktrees) {
        const cached = tuiRuntime.runSync(
          PrCacheService.use((s) => s.getWorkspace(repo.repoPath, wt.branch)),
        );
        if (cached)
          associations.set(
            workspaceIdentityKey(repo.repoPath, wt.branch),
            cached,
          );
      }
    } catch {
      /* cache errors leave unknown data */
    }
  }
  return { associations, openPrs };
}

export function useGitHub(repos: RepoInfo[]) {
  const [initial] = useState(() => hydrate(repos));
  const [associations, setAssociations] = useState(initial.associations);
  const [openPrs, setOpenPrs] = useState(initial.openPrs);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [refreshingProjects, setRefreshingProjects] = useState<Set<string>>(
    new Set(),
  );
  const reposRef = useRef(repos);
  reposRef.current = repos;
  const repoSignature = JSON.stringify(
    repos.map((repo) => [
      repo.repoPath,
      repo.worktrees.map((wt) => [wt.branch, wt.path]),
    ]),
  );
  const discovery = useRef(new Map<string, PrDiscoverySnapshot>());
  const discoveryRetries = useRef(
    new Map<string, { baseRepository: string; retryAfter: number }>(),
  );
  const inFlight = useRef<
    Map<
      string,
      { promise: Promise<void>; signal?: AbortSignal; signature: string }
    >
  >(new Map());

  useEffect(() => {
    const cache = hydrate(repos);
    setAssociations((previous) => {
      const next = new Map(previous);
      for (const [key, entry] of cache.associations)
        if (!next.has(key)) next.set(key, entry);
      return next;
    });
    setOpenPrs((previous) => {
      const next = new Map(previous);
      for (const [key, prs] of cache.openPrs)
        if (!next.has(key)) next.set(key, prs);
      return next;
    });
  }, [repos]);

  const refreshOne = useCallback(
    async (repo: RepoInfo, full: boolean, signal?: AbortSignal) => {
      let running = inFlight.current.get(repo.repoPath);
      const signature = worktreeSignature(repo);
      while (running && !running.signal?.aborted) {
        await running.promise;
        if (signal?.aborted) return;
        if (running.signature === signature) return;
        running = inFlight.current.get(repo.repoPath);
      }
      const isCurrent = () => {
        const current = reposRef.current.find(
          (target) => target.repoPath === repo.repoPath,
        );
        return (
          !signal?.aborted &&
          current !== undefined &&
          worktreeSignature(current) === signature
        );
      };
      if (!isCurrent()) return;
      let attemptedHistory: string | undefined;
      let promise!: Promise<void>;
      promise = (async () => {
        setRefreshingProjects((previous) =>
          new Set(previous).add(repo.repoPath),
        );
        try {
          const opts = signal ? { signal } : undefined;
          const base = await tuiRuntime.runPromise(
            GitHubService.use((s) => s.resolveBaseRepo(repo.repoPath)),
            opts,
          );
          const previous = full
            ? null
            : (discovery.current.get(repo.repoPath) ?? null);
          const needsHistory =
            previous?.baseRepository.toLowerCase() !== base.toLowerCase();
          const retry = discoveryRetries.current.get(repo.repoPath);
          if (
            needsHistory &&
            !full &&
            retry?.baseRepository.toLowerCase() === base.toLowerCase() &&
            Date.now() < retry.retryAfter
          )
            return;
          if (needsHistory) attemptedHistory = base;
          const workspaces = await Promise.all(
            repo.worktrees
              .filter((wt) => !wt.isMainWorktree)
              .map(async (wt) => {
                const [destination, explicit] = await Promise.all([
                  tuiRuntime.runPromise(
                    resolvePushDestination(wt.path, wt.branch),
                    opts,
                  ),
                  tuiRuntime.runPromise(
                    PrCacheService.use((s) =>
                      s.getExplicit(repo.repoPath, wt.branch),
                    ),
                  ),
                ]);
                return { branch: wt.branch, destination, explicit };
              }),
          );
          const {
            snapshot,
            open,
            explicitPrs,
            fetchedAt: now,
          } = await tuiRuntime.runPromise(
            refreshPrDiscovery(repo.repoPath, base, workspaces, previous),
            opts,
          );
          const found = new Map<string, WorkspacePrEntry>();
          for (const wt of workspaces) {
            found.set(
              workspaceIdentityKey(repo.repoPath, wt.branch),
              resolveWorkspacePr(
                snapshot.prs,
                wt.branch,
                wt.destination,
                wt.explicit,
                now,
                wt.explicit
                  ? (explicitPrs.get(prIdentity(wt.explicit)) ?? null)
                  : null,
              ),
            );
          }
          const candidates = [
            ...new Map(
              [...found.values()]
                .flatMap((entry) => [entry.pr, ...entry.candidates])
                .filter((pr): pr is PrFacts => pr !== null)
                .map((pr) => [prIdentity(pr), pr]),
            ).values(),
          ];
          const byBase = new Map<string, PrFacts[]>();
          for (const pr of candidates) {
            const group = byBase.get(pr.baseRepository) ?? [];
            group.push(pr);
            byBase.set(pr.baseRepository, group);
          }
          const detailed = (
            await Promise.all(
              [...byBase].map(([repository, prs]) =>
                tuiRuntime.runPromise(
                  fetchPrDetails(repo.repoPath, repository, prs),
                  opts,
                ),
              ),
            )
          ).flat();
          const details = new Map(detailed.map((pr) => [prIdentity(pr), pr]));
          for (const [identity, entry] of found) {
            if (entry.pr) entry.pr = details.get(prIdentity(entry.pr)) ?? null;
            entry.candidates = entry.candidates.map(
              (pr) => details.get(prIdentity(pr)) ?? pr,
            );
            if (entry.pr?.lastError) {
              const failedPr = entry.pr;
              const branch = repo.worktrees.find(
                (wt) =>
                  workspaceIdentityKey(repo.repoPath, wt.branch) === identity,
              )?.branch;
              const cached = branch
                ? await tuiRuntime.runPromise(
                    PrCacheService.use((s) =>
                      s.getWorkspace(repo.repoPath, branch),
                    ),
                  )
                : null;
              if (
                cached?.pr?.number === failedPr.number &&
                cached.pr.baseRepository === failedPr.baseRepository &&
                cached.pr.checksComplete
              ) {
                entry.pr = cached.pr;
              } else {
                entry.pr = null;
                entry.uncertain = true;
              }
              entry.lastError =
                details.get(prIdentity(failedPr))?.lastError ??
                "Incomplete PR data";
            }
            if (
              entry.pr === null &&
              entry.candidates.some((candidate) => !candidate.checksComplete)
            )
              entry.uncertain = true;
            entry.lastError ??=
              entry.candidates.find(
                (candidate) => candidate.lastError || !candidate.checksComplete,
              )?.lastError ??
              (entry.candidates.some((candidate) => !candidate.checksComplete)
                ? "Incomplete PR data"
                : null);
          }
          if (!isCurrent()) return;
          await Promise.all([
            ...repo.worktrees
              .filter((wt) => !wt.isMainWorktree)
              .map((wt) => {
                const entry = found.get(
                  workspaceIdentityKey(repo.repoPath, wt.branch),
                );
                return entry
                  ? tuiRuntime.runPromise(
                      PrCacheService.use((s) =>
                        s.setWorkspace(repo.repoPath, wt.branch, entry),
                      ),
                    )
                  : Promise.resolve();
              }),
            tuiRuntime.runPromise(
              PrCacheService.use((s) =>
                s.setOpenPrs(repo.repoPath, open.map(displayPr)),
              ),
            ),
            ...(!repo.error
              ? [
                  tuiRuntime.runPromise(
                    PrCacheService.use((s) =>
                      s.pruneWorkspaces(
                        repo.repoPath,
                        repo.worktrees
                          .filter((wt) => !wt.isMainWorktree)
                          .map((wt) => wt.branch),
                      ),
                    ),
                  ),
                ]
              : []),
          ]);
          if (!isCurrent()) return;
          discovery.current.set(repo.repoPath, snapshot);
          discoveryRetries.current.delete(repo.repoPath);
          setAssociations((previous) => {
            const next = new Map(
              [...previous].filter(
                ([key]) => !key.startsWith(`${repo.repoPath}\0`),
              ),
            );
            for (const [key, entry] of found) next.set(key, entry);
            return next;
          });
          setOpenPrs((previous) =>
            new Map(previous).set(repo.repoPath, open.map(displayPr)),
          );
          setErrors((previous) => {
            const next = new Map(previous);
            const error = [...found.values()].find(
              (entry) => entry.lastError,
            )?.lastError;
            if (error) next.set(repo.repoPath, error);
            else next.delete(repo.repoPath);
            return next;
          });
        } catch (cause) {
          if (!isCurrent()) return;
          if (attemptedHistory)
            discoveryRetries.current.set(repo.repoPath, {
              baseRepository: attemptedHistory,
              retryAfter: Date.now() + DISCOVERY_RETRY_DELAY,
            });
          const message =
            cause instanceof Error ? cause.message : String(cause);
          setErrors((previous) =>
            new Map(previous).set(repo.repoPath, message),
          );
          for (const wt of repo.worktrees.filter(
            (worktree) => !worktree.isMainWorktree,
          ))
            void tuiRuntime
              .runPromise(
                PrCacheService.use((s) =>
                  s.setWorkspaceError(repo.repoPath, wt.branch, message),
                ),
              )
              .catch(() => {});
          setAssociations(
            (previous) =>
              new Map(
                [...previous].map(([key, entry]) =>
                  key.startsWith(`${repo.repoPath}\0`)
                    ? [key, { ...entry, lastError: message }]
                    : [key, entry],
                ),
              ),
          );
        } finally {
          if (inFlight.current.get(repo.repoPath)?.promise === promise) {
            inFlight.current.delete(repo.repoPath);
            setRefreshingProjects((previous) => {
              const next = new Set(previous);
              next.delete(repo.repoPath);
              return next;
            });
          }
        }
      })();
      inFlight.current.set(repo.repoPath, { promise, signal, signature });
      return promise;
    },
    [],
  );

  const refreshTargets = useCallback(
    async (repoPath?: string, signal?: AbortSignal, full = false) => {
      const targets =
        repoPath !== undefined
          ? reposRef.current.filter((repo) => repo.repoPath === repoPath)
          : reposRef.current;
      if (!targets.length) return;
      await Promise.allSettled(
        targets.map(async (repo) => {
          // Manual discovery must run even when a poll is already in flight.
          if (full) {
            let running = inFlight.current.get(repo.repoPath);
            while (running) {
              await running.promise;
              signal?.throwIfAborted();
              running = inFlight.current.get(repo.repoPath);
            }
          }
          const current = reposRef.current.find(
            (target) => target.repoPath === repo.repoPath,
          );
          if (current) await refreshOne(current, full, signal);
        }),
      );
    },
    [refreshOne],
  );

  const refresh = useCallback(
    (repoPath?: string, signal?: AbortSignal) =>
      refreshTargets(repoPath, signal, true),
    [refreshTargets],
  );

  const refreshAfterCurrent = useCallback(
    async (repoPath: string) => {
      // A request started before a merge can return the old PR state.
      // Wait for it to finish before starting the post-submission read.
      let running = inFlight.current.get(repoPath);
      while (running) {
        await running.promise;
        running = inFlight.current.get(repoPath);
      }
      await refreshTargets(repoPath);
    },
    [refreshTargets],
  );

  const setExplicit = useCallback(
    async (repoPath: string, branch: string, pr: PrFacts) => {
      await tuiRuntime.runPromise(
        PrCacheService.use((s) =>
          s.setExplicit(repoPath, branch, {
            baseRepository: pr.baseRepository,
            number: pr.number,
          }),
        ),
      );
      await refreshAfterCurrent(repoPath);
    },
    [refreshAfterCurrent],
  );
  const clearExplicit = useCallback(
    async (repoPath: string, branch: string) => {
      await tuiRuntime.runPromise(
        PrCacheService.use((s) => s.clearExplicit(repoPath, branch)),
      );
      await refreshAfterCurrent(repoPath);
    },
    [refreshAfterCurrent],
  );

  useEffect(() => {
    const controller = new AbortController();
    const present = new Set(reposRef.current.map((repo) => repo.repoPath));
    for (const path of discovery.current.keys())
      if (!present.has(path)) discovery.current.delete(path);
    for (const path of discoveryRetries.current.keys())
      if (!present.has(path)) discoveryRetries.current.delete(path);
    if (repoSignature !== "[]")
      void refreshTargets(undefined, controller.signal);
    return () => controller.abort();
  }, [repoSignature, refreshTargets]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setInterval(
      () => void refreshTargets(undefined, controller.signal),
      GITHUB_POLL_INTERVAL,
    );
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refreshTargets]);

  const prData = useMemo(() => {
    const data = new Map<string, PRInfo>();
    for (const [key, entry] of associations)
      if (entry.pr)
        data.set(
          key,
          displayPr({
            ...entry.pr,
            lastError: entry.lastError ?? entry.pr.lastError,
          }),
        );
    return data;
  }, [associations]);
  return {
    prData,
    associations,
    openPrs,
    errors,
    refresh,
    refreshCurrent: refreshTargets,
    refreshAfterCurrent,
    refreshingProjects,
    setExplicit,
    clearExplicit,
  };
}

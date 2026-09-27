import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitHubService } from "../../services/github-service";
import {
  PrCacheService,
  type WorkspacePrEntry,
} from "../../services/pr-cache-service";
import { fetchPrDetails } from "../../services/pr-details";
import {
  normalizeGhPr,
  resolvePushDestination,
  resolveWorkspacePr,
} from "../../services/pr-discovery";
import { checkSummary, type PrFacts } from "../../services/pr-model";
import { lifecycleKey } from "../lifecycle";
import { tuiRuntime } from "../runtime";
import type { PRInfo } from "../types";
import type { RepoInfo } from "./useRegistry";

const GITHUB_POLL_INTERVAL = 120_000;
const CACHE_FRESH_WINDOW = 30_000;

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
          associations.set(lifecycleKey(repo.repoPath, wt.branch), cached);
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
  const [loading, setLoading] = useState(false);
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
  const firstRefresh = useRef(true);
  const inFlight = useRef<Map<string, Promise<void>>>(new Map());

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
    async (repo: RepoInfo, first: boolean, signal?: AbortSignal) => {
      const running = inFlight.current.get(repo.repoPath);
      if (running) return running;
      if (first && repo.worktrees.length) {
        try {
          const cached = tuiRuntime.runSync(
            PrCacheService.use((s) =>
              s.getWorkspace(repo.repoPath, repo.worktrees[0]?.branch ?? ""),
            ),
          );
          if (
            cached &&
            !cached.lastError &&
            Date.now() - cached.fetchedAt < CACHE_FRESH_WINDOW
          )
            return;
        } catch {
          /* fetch */
        }
      }
      const promise = (async () => {
        setRefreshingProjects((previous) =>
          new Set(previous).add(repo.repoPath),
        );
        try {
          const opts = signal ? { signal } : undefined;
          const base = await tuiRuntime.runPromise(
            GitHubService.use((s) => s.resolveBaseRepo(repo.repoPath)),
            opts,
          );
          const [rawAll, rawOpen] = await Promise.all([
            tuiRuntime.runPromise(
              GitHubService.use((s) => s.listRawPrs(repo.repoPath, "all")),
              opts,
            ),
            tuiRuntime.runPromise(
              GitHubService.use((s) => s.listRawPrs(repo.repoPath, "open")),
              opts,
            ),
          ]);
          const now = Date.now();
          const all = rawAll
            .map((raw) => normalizeGhPr(raw, base, now))
            .filter((pr): pr is PrFacts => pr !== null);
          const open = rawOpen
            .map((raw) => normalizeGhPr(raw, base, now))
            .filter((pr): pr is PrFacts => pr !== null && pr.state === "OPEN");
          const found = new Map<string, WorkspacePrEntry>();
          for (const wt of repo.worktrees) {
            if (wt.isMainWorktree) continue;
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
            found.set(
              lifecycleKey(repo.repoPath, wt.branch),
              resolveWorkspacePr(all, wt.branch, destination, explicit, now),
            );
          }
          const candidates = [
            ...new Map(
              [...found.values()]
                .flatMap((entry) => [entry.pr, ...entry.candidates])
                .filter((pr): pr is PrFacts => pr !== null)
                .map((pr) => [pr.number, pr]),
            ).values(),
          ];
          const detailed = await tuiRuntime.runPromise(
            fetchPrDetails(repo.repoPath, base, candidates),
            opts,
          );
          const details = new Map(detailed.map((pr) => [pr.number, pr]));
          for (const [identity, entry] of found) {
            if (entry.pr) entry.pr = details.get(entry.pr.number) ?? null;
            entry.candidates = entry.candidates.map(
              (pr) => details.get(pr.number) ?? pr,
            );
            if (entry.pr?.lastError) {
              const branch = repo.worktrees.find(
                (wt) => lifecycleKey(repo.repoPath, wt.branch) === identity,
              )?.branch;
              const cached = branch
                ? await tuiRuntime.runPromise(
                    PrCacheService.use((s) =>
                      s.getWorkspace(repo.repoPath, branch),
                    ),
                  )
                : null;
              if (
                cached?.pr?.number === entry.pr.number &&
                cached.pr.baseRepository === entry.pr.baseRepository &&
                cached.pr.checksComplete
              ) {
                entry.pr = cached.pr;
              } else {
                entry.pr = null;
                entry.uncertain = true;
              }
              entry.lastError =
                details.get(
                  cached?.pr?.number ?? entry.candidates[0]?.number ?? -1,
                )?.lastError ?? "Incomplete PR data";
            }
            if (
              entry.pr === null &&
              entry.candidates.some((candidate) => !candidate.checksComplete)
            )
              entry.uncertain = true;
          }
          if (signal?.aborted) return;
          await Promise.all([
            ...repo.worktrees
              .filter((wt) => !wt.isMainWorktree)
              .map((wt) => {
                const entry = found.get(lifecycleKey(repo.repoPath, wt.branch));
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
            next.delete(repo.repoPath);
            return next;
          });
        } catch (cause) {
          if (signal?.aborted) return;
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
          inFlight.current.delete(repo.repoPath);
          setRefreshingProjects((previous) => {
            const next = new Set(previous);
            next.delete(repo.repoPath);
            return next;
          });
        }
      })();
      inFlight.current.set(repo.repoPath, promise);
      return promise;
    },
    [],
  );

  const refresh = useCallback(
    async (project?: string, signal?: AbortSignal) => {
      const targets = project
        ? reposRef.current.filter(
            (repo) => repo.project === project || repo.repoPath === project,
          )
        : reposRef.current;
      if (!targets.length) return;
      const first = firstRefresh.current;
      firstRefresh.current = false;
      setLoading(true);
      try {
        await Promise.allSettled(
          targets.map((repo) => refreshOne(repo, first, signal)),
        );
      } finally {
        setLoading(false);
      }
    },
    [refreshOne],
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
      await refresh(repoPath);
    },
    [refresh],
  );
  const clearExplicit = useCallback(
    async (repoPath: string, branch: string) => {
      await tuiRuntime.runPromise(
        PrCacheService.use((s) => s.clearExplicit(repoPath, branch)),
      );
      await refresh(repoPath);
    },
    [refresh],
  );

  useEffect(() => {
    const controller = new AbortController();
    if (repoSignature !== "[]") void refresh(undefined, controller.signal);
    return () => controller.abort();
  }, [repoSignature, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setInterval(
      () => void refresh(undefined, controller.signal),
      GITHUB_POLL_INTERVAL,
    );
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);

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
    loading,
    refresh,
    refreshingProjects,
    setExplicit,
    clearExplicit,
  };
}

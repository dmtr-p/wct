import { useCallback, useEffect, useRef, useState } from "react";
import { GitHubService } from "../../services/github-service";
import { PrCacheService } from "../../services/pr-cache-service";
import { tuiRuntime } from "../runtime";
import type { PRInfo } from "../types";
import type { RepoInfo } from "./useRegistry";

const GITHUB_POLL_INTERVAL = 120_000; // 120 seconds
const CACHE_FRESH_WINDOW = 30_000; // skip initial fetch if cache is < 30s old

interface InitialCacheState {
  prData: Map<string, PRInfo>;
  errors: Map<string, string>;
}

function readCacheSync(repos: RepoInfo[]): InitialCacheState {
  const prData = new Map<string, PRInfo>();
  const errors = new Map<string, string>();
  for (const repo of repos) {
    try {
      const entry = tuiRuntime.runSync(
        PrCacheService.use((s) => s.getCached(repo.project)),
      );
      if (entry !== null) {
        for (const pr of entry.payload) {
          prData.set(`${repo.project}/${pr.headRefName}`, pr);
        }
        if (entry.lastError !== null) {
          errors.set(repo.project, entry.lastError);
        }
      }
    } catch {
      // Cache read failed — start with empty state for this repo
    }
  }
  return { prData, errors };
}

async function fetchRepoData(
  repo: RepoInfo,
  signal?: AbortSignal,
): Promise<{ entries: [string, PRInfo][]; prs: PRInfo[] }> {
  const opts = signal ? { signal } : undefined;
  const prs = await tuiRuntime.runPromise(
    GitHubService.use((s) => s.listPrs(repo.repoPath)),
    opts,
  );

  const entries: [string, PRInfo][] = prs.map((pr) => [
    `${repo.project}/${pr.headRefName}`,
    { ...pr },
  ]);

  return { entries, prs };
}

export function useGitHub(repos: RepoInfo[]) {
  // Both state slices are initialised from a single synchronous DB scan.
  // We use a lazily-evaluated tuple state so the scan runs at most once.
  const [{ prData: _initPrData, errors: _initErrors }] =
    useState<InitialCacheState>(() => readCacheSync(repos));
  const [prData, setPrData] = useState<Map<string, PRInfo>>(_initPrData);
  const [errors, setErrors] = useState<Map<string, string>>(_initErrors);
  const [loading, setLoading] = useState(false);
  // Set of project names currently being fetched — drives ↻ indicator re-renders
  const [refreshingProjects, setRefreshingProjects] = useState<Set<string>>(
    new Set(),
  );
  const reposRef = useRef(repos);
  reposRef.current = repos;
  // Tracks whether the very first refresh call has completed; only the first
  // call applies the 30s "fresh cache" debounce (rapid-relaunch guard).
  const isFirstRefreshRef = useRef(true);
  // Per-project in-flight promises — concurrent callers share the same fetch.
  const inFlightRef = useRef<Map<string, Promise<void>>>(new Map());

  const refreshOne = useCallback(
    async (repo: RepoInfo, isFirst: boolean, signal?: AbortSignal) => {
      const project = repo.project;

      // Coalesce: return existing in-flight promise if one exists for this project
      const existing = inFlightRef.current.get(project);
      if (existing !== undefined) {
        return existing;
      }

      // On the first overall call only: skip fetch if the cache is fresh enough
      // (debounce against rapid TUI relaunches within 30s). Done synchronously
      // before creating the in-flight promise so a skipped fetch doesn't store
      // a permanently-resolved promise in inFlightRef and block future fetches.
      if (isFirst) {
        try {
          const cached = tuiRuntime.runSync(
            PrCacheService.use((s) => s.getCached(project)),
          );
          if (
            cached !== null &&
            Date.now() - cached.fetchedAt < CACHE_FRESH_WINDOW
          ) {
            return;
          }
        } catch {
          // If cache read fails, proceed with fetch
        }
      }

      const promise = (async () => {
        setRefreshingProjects((prev) => {
          const next = new Set(prev);
          next.add(project);
          return next;
        });

        try {
          // Fetch — may throw on error or abort
          const { entries, prs } = await fetchRepoData(repo, signal);

          // Write to cache only on success and only if not aborted
          if (!signal?.aborted) {
            tuiRuntime
              .runPromise(PrCacheService.use((s) => s.setCached(project, prs)))
              .catch(() => {
                // Cache write failure is non-fatal
              });

            // Clear any previous error for this project
            setErrors((prev) => {
              if (!prev.has(project)) return prev;
              const next = new Map(prev);
              next.delete(project);
              return next;
            });

            setPrData((prev) => {
              const next = new Map(prev);
              for (const [key, pr] of entries) {
                next.set(key, pr);
              }
              return next;
            });
          }
        } catch (err) {
          // Don't write error if aborted
          if (!signal?.aborted) {
            const errMsg =
              err instanceof Error
                ? err.message
                : String(err ?? "unknown error");
            tuiRuntime
              .runPromise(
                PrCacheService.use((s) => s.setError(project, errMsg)),
              )
              .catch(() => {
                // Cache error write failure is non-fatal
              });

            // Surface the error in the errors map
            setErrors((prev) => {
              const next = new Map(prev);
              next.set(project, errMsg);
              return next;
            });
          }
        } finally {
          inFlightRef.current.delete(project);
          setRefreshingProjects((prev) => {
            const next = new Set(prev);
            next.delete(project);
            return next;
          });
        }
      })();

      inFlightRef.current.set(project, promise);
      return promise;
    },
    [],
  );

  // refresh(project?) — when called with a project, refreshes only that one;
  // when called without args, refreshes all repos.
  const refresh = useCallback(
    async (project?: string, signal?: AbortSignal) => {
      const repos = reposRef.current;
      if (repos.length === 0) return;

      const isFirst = isFirstRefreshRef.current;
      isFirstRefreshRef.current = false;

      const targets = project
        ? repos.filter((r) => r.project === project)
        : repos;

      if (targets.length === 0) return;

      setLoading(true);
      try {
        await Promise.allSettled(
          targets.map((repo) => refreshOne(repo, isFirst, signal)),
        );
      } finally {
        setLoading(false);
      }
    },
    [refreshOne],
  );

  useEffect(() => {
    const controller = new AbortController();
    refresh(undefined, controller.signal);
    const id = setInterval(
      () => refresh(undefined, controller.signal),
      GITHUB_POLL_INTERVAL,
    );
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [refresh]);

  return { prData, errors, loading, refresh, refreshingProjects };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { GitHubService } from "../../services/github-service";
import { PrCacheService } from "../../services/pr-cache-service";
import { tuiRuntime } from "../runtime";
import type { PRInfo } from "../types";
import type { RepoInfo } from "./useRegistry";

const GITHUB_POLL_INTERVAL = 30_000; // 30 seconds
const CACHE_FRESH_WINDOW = 30_000; // skip initial fetch if cache is < 30s old

function readCacheSync(repos: RepoInfo[]): Map<string, PRInfo> {
  const map = new Map<string, PRInfo>();
  for (const repo of repos) {
    try {
      const entry = tuiRuntime.runSync(
        PrCacheService.use((s) => s.getCached(repo.project)),
      );
      if (entry !== null) {
        for (const pr of entry.payload) {
          map.set(`${repo.project}/${pr.headRefName}`, pr);
        }
      }
    } catch {
      // Cache read failed — start with empty state for this repo
    }
  }
  return map;
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
  const [prData, setPrData] = useState<Map<string, PRInfo>>(() =>
    readCacheSync(repos),
  );
  const [loading, setLoading] = useState(false);
  const reposRef = useRef(repos);
  reposRef.current = repos;
  // Tracks whether the very first refresh call has completed; only the first
  // call applies the 30s "fresh cache" debounce (rapid-relaunch guard).
  const isFirstRefreshRef = useRef(true);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (reposRef.current.length === 0) return;
    setLoading(true);
    const isFirst = isFirstRefreshRef.current;
    isFirstRefreshRef.current = false;
    try {
      const results = await Promise.allSettled(
        reposRef.current.map(async (repo) => {
          // On the first call only: skip fetch if the cache is fresh enough
          // (debounce against rapid TUI relaunches within 30s).
          if (isFirst) {
            let skipFetch = false;
            try {
              const cached = tuiRuntime.runSync(
                PrCacheService.use((s) => s.getCached(repo.project)),
              );
              if (
                cached !== null &&
                Date.now() - cached.fetchedAt < CACHE_FRESH_WINDOW
              ) {
                skipFetch = true;
              }
            } catch {
              // If cache read fails, proceed with fetch
            }
            if (skipFetch) {
              return null; // signal: use whatever is already in prData
            }
          }

          // Fetch — may throw on error or abort
          const { entries, prs } = await fetchRepoData(repo, signal);

          // Write to cache (only on success and only if not aborted)
          if (!signal?.aborted) {
            tuiRuntime
              .runPromise(
                PrCacheService.use((s) => s.setCached(repo.project, prs)),
              )
              .catch(() => {
                // Cache write failure is non-fatal
              });
          }

          return entries;
        }),
      );

      // Build new map: start from current prData to preserve skipped repos,
      // then overlay successful fetch results.
      setPrData((prev) => {
        const next = new Map(prev);
        for (const result of results) {
          if (result.status === "fulfilled" && result.value !== null) {
            for (const [key, pr] of result.value) {
              next.set(key, pr);
            }
          }
        }
        return next;
      });

      // Handle errors: write last_error for repos that failed (but not aborts)
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const repo = reposRef.current[i];
        if (
          result.status === "rejected" &&
          !signal?.aborted &&
          repo !== undefined
        ) {
          const errMsg =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason ?? "unknown error");
          tuiRuntime
            .runPromise(
              PrCacheService.use((s) => s.setError(repo.project, errMsg)),
            )
            .catch(() => {
              // Cache error write failure is non-fatal
            });
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    const id = setInterval(
      () => refresh(controller.signal),
      GITHUB_POLL_INTERVAL,
    );
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [refresh]);

  return { prData, loading, refresh };
}

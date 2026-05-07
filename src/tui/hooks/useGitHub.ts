import { useCallback, useEffect, useRef, useState } from "react";
import { GitHubService } from "../../services/github-service";
import { tuiRuntime } from "../runtime";
import type { PRInfo } from "../types";
import type { RepoInfo } from "./useRegistry";

const GITHUB_POLL_INTERVAL = 30_000; // 30 seconds

async function fetchRepoData(
  repo: RepoInfo,
  signal?: AbortSignal,
): Promise<[string, PRInfo][]> {
  const entries: [string, PRInfo][] = [];
  const opts = signal ? { signal } : undefined;
  try {
    const prs = await tuiRuntime.runPromise(
      GitHubService.use((s) => s.listPrs(repo.repoPath)),
      opts,
    );

    for (const pr of prs) {
      const key = `${repo.project}/${pr.headRefName}`;
      entries.push([key, { ...pr }]);
    }
  } catch {
    // gh not installed or not authenticated — silently skip
  }
  return entries;
}

export function useGitHub(repos: RepoInfo[]) {
  const [prData, setPrData] = useState<Map<string, PRInfo>>(new Map());
  const [loading, setLoading] = useState(false);
  const reposRef = useRef(repos);
  reposRef.current = repos;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (reposRef.current.length === 0) return;
    setLoading(true);
    try {
      const allEntries = await Promise.all(
        reposRef.current.map((repo) => fetchRepoData(repo, signal)),
      );
      setPrData(new Map(allEntries.flat()));
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

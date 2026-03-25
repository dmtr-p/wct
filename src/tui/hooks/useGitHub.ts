import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckInfo, PRInfo } from "../types";
import type { RepoInfo } from "./useRegistry";

const GITHUB_POLL_INTERVAL = 30_000; // 30 seconds

/** Parse `gh pr list --json ...` output */
export function parseGhPrList(stdout: string): Omit<PRInfo, "checks">[] {
  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) return [];
    return data.map((pr: Record<string, unknown>) => ({
      number: pr.number as number,
      title: pr.title as string,
      state: pr.state as PRInfo["state"],
      headRefName: pr.headRefName as string,
    }));
  } catch {
    return [];
  }
}

/** Parse `gh pr checks --json ...` output */
export function parseGhPrChecks(stdout: string): CheckInfo[] {
  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) return [];
    return data.map((c: Record<string, unknown>) => ({
      name: c.name as string,
      state: c.state as string,
    }));
  } catch {
    return [];
  }
}

async function runGh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`gh exited with ${code}`);
  return text.trim();
}

async function fetchRepoData(repo: RepoInfo): Promise<[string, PRInfo][]> {
  const entries: [string, PRInfo][] = [];
  try {
    const prJson = await runGh(
      [
        "pr",
        "list",
        "--json",
        "number,title,state,headRefName",
        "--limit",
        "20",
      ],
      repo.repoPath,
    );
    const prs = parseGhPrList(prJson);

    await Promise.all(
      prs.map(async (pr) => {
        let checks: CheckInfo[] = [];
        try {
          const checksJson = await runGh(
            ["pr", "checks", String(pr.number), "--json", "name,state"],
            repo.repoPath,
          );
          checks = parseGhPrChecks(checksJson);
        } catch {
          // Checks may not be available
        }
        const key = `${repo.project}/${pr.headRefName}`;
        entries.push([key, { ...pr, checks }]);
      }),
    );
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

  const refresh = useCallback(async () => {
    if (reposRef.current.length === 0) return;
    setLoading(true);
    try {
      const allEntries = await Promise.all(reposRef.current.map(fetchRepoData));
      setPrData(new Map(allEntries.flat()));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, GITHUB_POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  return { prData, loading, refresh };
}

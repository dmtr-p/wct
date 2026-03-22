// src/tui/hooks/useRegistry.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import { liveRegistryService } from "../../services/registry-service";

export interface WorktreeInfo {
  branch: string;
  path: string;
  isMainWorktree: boolean;
  changedFiles: number;
  sync: { ahead: number; behind: number } | null;
}

export interface RepoInfo {
  id: string;
  repoPath: string;
  project: string;
  worktrees: WorktreeInfo[];
  profileNames: string[];
  error?: string; // set if repo path is missing
}

async function getChangedCount(path: string): Promise<number> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const trimmed = text.trim();
    return trimmed ? trimmed.split("\n").length : 0;
  } catch {
    return 0;
  }
}

async function getSync(
  path: string,
  defaultBranch: string | null,
): Promise<{ ahead: number; behind: number } | null> {
  if (!defaultBranch) return null;
  try {
    const proc = Bun.spawn(
      ["git", "rev-list", "--left-right", "--count", `HEAD...${defaultBranch}`],
      { cwd: path, stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const [ahead, behind] = text
      .trim()
      .split(/\s+/)
      .map((n) => {
        const p = Number.parseInt(n, 10);
        return Number.isNaN(p) ? 0 : p;
      });
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  } catch {
    return null;
  }
}

async function getDefaultBranch(repoPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["git", "symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const branch = text.trim();
    if (branch) return branch;
  } catch {
    // symbolic-ref failed, try common defaults
  }

  for (const candidate of ["main", "master"]) {
    try {
      const proc = Bun.spawn(["git", "rev-parse", "--verify", candidate], {
        cwd: repoPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      if (proc.exitCode === 0) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function getProfileNames(repoPath: string): string[] {
  try {
    const paths = [join(repoPath, ".wct.yaml"), join(homedir(), ".wct.yaml")];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      const content = readFileSync(p, "utf-8");
      const parsed = Bun.YAML.parse(content);
      if (parsed?.profiles && typeof parsed.profiles === "object") {
        return Object.keys(parsed.profiles);
      }
    }
    return [];
  } catch {
    return [];
  }
}

async function discoverWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  try {
    const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of text.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) {
          worktrees.push(current as WorktreeInfo);
        }
        current = {
          path: line.slice(9),
          isMainWorktree: false,
          changedFiles: 0,
          sync: null,
        };
      } else if (line.startsWith("branch refs/heads/")) {
        current.branch = line.slice(18);
      } else if (line === "bare") {
        current = {};
      } else if (line.startsWith("HEAD ")) {
        // detached HEAD — use short SHA as branch display
        if (!current.branch) {
          current.branch = `(detached)`;
        }
      }
    }
    if (current.path && current.branch) {
      worktrees.push(current as WorktreeInfo);
    }

    // Mark first worktree as main
    if (worktrees.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length check guarantees index 0 exists
      worktrees[0]!.isMainWorktree = true;
    }

    return worktrees;
  } catch {
    return [];
  }
}

export function useRegistry() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const items = await Effect.runPromise(liveRegistryService.listRepos());
      const repoInfos: RepoInfo[] = await Promise.all(
        items.map(async (item) => {
          if (!existsSync(item.repo_path)) {
            return {
              id: item.id,
              repoPath: item.repo_path,
              project: item.project,
              worktrees: [],
              profileNames: [],
              error: "Directory not found",
            };
          }
          const [worktrees, defaultBranch] = await Promise.all([
            discoverWorktrees(item.repo_path),
            getDefaultBranch(item.repo_path),
          ]);
          const profileNames = getProfileNames(item.repo_path);
          await Promise.all(
            worktrees.map(async (wt) => {
              const [changedFiles, sync] = await Promise.all([
                getChangedCount(wt.path),
                getSync(wt.path, defaultBranch),
              ]);
              wt.changedFiles = changedFiles;
              wt.sync = sync;
            }),
          );
          return {
            id: item.id,
            repoPath: item.repo_path,
            project: item.project,
            worktrees,
            profileNames,
          };
        }),
      );
      setRepos(repoInfos);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { repos, loading, refresh };
}

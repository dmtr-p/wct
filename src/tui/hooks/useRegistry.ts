// src/tui/hooks/useRegistry.ts
import { existsSync } from "node:fs";
import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import { liveRegistryService } from "../../services/registry-service";

export interface WorktreeInfo {
  branch: string;
  path: string;
  isMainWorktree: boolean;
}

export interface RepoInfo {
  id: string;
  repoPath: string;
  project: string;
  worktrees: WorktreeInfo[];
  error?: string; // set if repo path is missing
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
        current = { path: line.slice(9), isMainWorktree: false };
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
              error: "Directory not found",
            };
          }
          const worktrees = await discoverWorktrees(item.repo_path);
          return {
            id: item.id,
            repoPath: item.repo_path,
            project: item.project,
            worktrees,
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

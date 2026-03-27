import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { useCallback, useEffect, useState } from "react";
import { RegistryService } from "../../services/registry-service";
import { WorktreeService } from "../../services/worktree-service";
import { tuiRuntime } from "../runtime";

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
  error?: string;
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

export function useRegistry() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const items = await tuiRuntime.runPromise(
        RegistryService.use((s) => s.listRepos()),
      );
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

          const [worktreeList, defaultBranch] = await Promise.all([
            tuiRuntime.runPromise(
              WorktreeService.use((s) => s.listWorktrees(item.repo_path)),
            ),
            tuiRuntime.runPromise(
              WorktreeService.use((s) => s.getDefaultBranch(item.repo_path)),
            ),
          ]);

          const profileNames = getProfileNames(item.repo_path);

          const worktrees: WorktreeInfo[] = worktreeList
            .filter((wt) => !wt.isBare)
            .map((wt, index) => ({
              branch: wt.branch,
              path: wt.path,
              isMainWorktree: index === 0,
              changedFiles: 0,
              sync: null,
            }));

          await Promise.all(
            worktrees.map(async (wt) => {
              const [changedFiles, sync] = await Promise.all([
                tuiRuntime.runPromise(
                  WorktreeService.use((s) => s.getChangedFileCount(wt.path)),
                ),
                defaultBranch
                  ? tuiRuntime.runPromise(
                      WorktreeService.use((s) =>
                        s.getAheadBehind(wt.path, defaultBranch),
                      ),
                    )
                  : Promise.resolve(null),
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
    } catch {
      // Swallow — previous repos preserved, next poll/watch will retry
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { repos, loading, refresh };
}

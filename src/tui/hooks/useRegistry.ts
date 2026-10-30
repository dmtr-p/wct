import { existsSync } from "node:fs";
import { useCallback, useEffect, useState } from "react";
import { loadConfig } from "../../config/loader";
import type { ResolvedConfig } from "../../config/schema";
import { RegistryService } from "../../services/registry-service";
import { WorktreeService } from "../../services/worktree-service";
import { tuiRuntime } from "../runtime";
import { useRefreshGeneration } from "./useRefreshGeneration";

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
  /** Project Display Name from the registry, not the configured project_name. */
  project: string;
  worktrees: WorktreeInfo[];
  profileNames: string[];
  baseBranch?: string;
  error?: string;
}

interface RegistryRepoItem {
  id: string;
  repo_path: string;
  project: string;
}

interface LoadRepoInfoDeps {
  pathExists: (path: string) => boolean;
  getConfig: (
    repoPath: string,
  ) => Promise<Pick<ResolvedConfig, "profiles" | "base_branch">>;
  listWorktrees: (
    repoPath: string,
  ) => Promise<import("../../services/worktree-service").Worktree[]>;
  getDefaultBranch: (repoPath: string) => Promise<string | null>;
  getChangedFileCount: (worktreePath: string) => Promise<number>;
  getAheadBehind: (
    worktreePath: string,
    ref: string,
  ) => Promise<{ ahead: number; behind: number } | null>;
}

export async function loadRepoInfo(
  item: RegistryRepoItem,
  deps: LoadRepoInfoDeps,
  signal?: AbortSignal,
): Promise<RepoInfo> {
  if (!deps.pathExists(item.repo_path)) {
    return {
      id: item.id,
      repoPath: item.repo_path,
      project: item.project,
      worktrees: [],
      profileNames: [],
      error: "Directory not found",
    };
  }

  const configPromise = deps
    .getConfig(item.repo_path)
    .catch((): Pick<ResolvedConfig, "profiles" | "base_branch"> => {
      signal?.throwIfAborted();
      return {};
    });

  let worktreeList: import("../../services/worktree-service").Worktree[];
  let defaultBranch: string | null;
  let config: Pick<ResolvedConfig, "profiles" | "base_branch">;

  try {
    [config, worktreeList, defaultBranch] = await Promise.all([
      configPromise,
      deps.listWorktrees(item.repo_path),
      deps.getDefaultBranch(item.repo_path),
    ]);
  } catch {
    signal?.throwIfAborted();
    const fallbackConfig = await configPromise;
    return {
      id: item.id,
      repoPath: item.repo_path,
      project: item.project,
      worktrees: [],
      profileNames: Object.keys(fallbackConfig.profiles ?? {}),
      ...(fallbackConfig.base_branch
        ? { baseBranch: fallbackConfig.base_branch }
        : {}),
      error: "Failed to inspect repository",
    };
  }

  const worktrees: WorktreeInfo[] = await Promise.all(
    worktreeList
      .filter((wt) => !wt.isBare)
      .map(async (wt, index) => {
        const exists = deps.pathExists(wt.path);
        const [changedFiles, sync] = await Promise.all([
          exists
            ? deps.getChangedFileCount(wt.path).catch(() => 0)
            : Promise.resolve(0),
          exists && defaultBranch
            ? deps.getAheadBehind(wt.path, defaultBranch).catch(() => null)
            : Promise.resolve(null),
        ]);
        return {
          branch: wt.branch,
          path: wt.path,
          isMainWorktree: index === 0,
          changedFiles,
          sync,
        };
      }),
  );

  return {
    id: item.id,
    repoPath: item.repo_path,
    project: item.project,
    worktrees,
    profileNames: Object.keys(config.profiles ?? {}),
    ...(config.base_branch ? { baseBranch: config.base_branch } : {}),
  };
}

export function useRegistry() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const { begin } = useRefreshGeneration();

  // Return this request's snapshot even when a newer one is already displayed.
  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<RepoInfo[] | null> => {
      const request = begin(signal);
      if (!request.isActive()) return null;
      const opts = signal ? { signal } : undefined;
      try {
        const items = await tuiRuntime.runPromise(
          RegistryService.use((s) => s.listRepos),
          opts,
        );
        const repoInfos: RepoInfo[] = await Promise.all(
          items.map((item) =>
            loadRepoInfo(
              item,
              {
                pathExists: existsSync,
                getConfig: (repoPath) =>
                  tuiRuntime.runPromise(loadConfig(repoPath), opts),
                listWorktrees: (repoPath) =>
                  tuiRuntime.runPromise(
                    WorktreeService.use((s) => s.listWorktrees(repoPath)),
                    opts,
                  ),
                getDefaultBranch: (repoPath) =>
                  tuiRuntime.runPromise(
                    WorktreeService.use((s) => s.getDefaultBranch(repoPath)),
                    opts,
                  ),
                getChangedFileCount: (worktreePath) =>
                  tuiRuntime.runPromise(
                    WorktreeService.use((s) =>
                      s.getChangedFileCount(worktreePath, {
                        logWarnings: false,
                      }),
                    ),
                    opts,
                  ),
                getAheadBehind: (worktreePath, ref) =>
                  tuiRuntime.runPromise(
                    WorktreeService.use((s) =>
                      s.getAheadBehind(worktreePath, ref, {
                        logWarnings: false,
                      }),
                    ),
                    opts,
                  ),
              },
              signal,
            ),
          ),
        );
        if (!request.isActive()) return null;
        if (request.accept()) setRepos(repoInfos);
        return repoInfos;
      } catch {
        // Swallow — previous repos preserved, next poll/watch will retry
        return null;
      } finally {
        if (request.accept()) setLoading(false);
      }
    },
    [begin],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return { repos, loading, refresh };
}

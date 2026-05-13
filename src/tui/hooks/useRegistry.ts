// src/tui/hooks/useRegistry.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { useCallback, useEffect, useState } from "react";
import {
  loadConfig,
  resolveIdeLaunch,
  resolveProfile,
} from "../../config/loader";
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

export interface IdeDefaults {
  baseNoIde: boolean;
  profileNoIde: Record<string, boolean>;
}

export interface RepoInfo {
  id: string;
  repoPath: string;
  project: string;
  worktrees: WorktreeInfo[];
  profileNames: string[];
  ideDefaults: IdeDefaults;
  error?: string;
}

function getProfileNames(repoPath: string): string[] {
  try {
    const paths = [join(repoPath, ".wct.yaml"), join(homedir(), ".wct.yaml")];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      const content = readFileSync(p, "utf-8");
      const parsed = Bun.YAML.parse(content) as { profiles?: object } | null;
      if (parsed?.profiles && typeof parsed.profiles === "object") {
        return Object.keys(parsed.profiles);
      }
    }
    return [];
  } catch {
    return [];
  }
}

interface RegistryRepoItem {
  id: string;
  repo_path: string;
  project: string;
}

interface LoadRepoInfoDeps {
  pathExists: (path: string) => boolean;
  getProfileNames: (repoPath: string) => string[];
  getIdeDefaults: (repoPath: string) => Promise<IdeDefaults>;
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

export async function getIdeDefaults(repoPath: string): Promise<IdeDefaults> {
  try {
    const { config } = await loadConfig(repoPath);
    if (!config) {
      return { baseNoIde: true, profileNoIde: {} };
    }
    const baseNoIde = !resolveIdeLaunch(config.ide, {}).open;
    const profileNoIde: Record<string, boolean> = {};
    for (const name of Object.keys(config.profiles ?? {})) {
      const { config: profiled } = resolveProfile(config, "main", name);
      profileNoIde[name] = !resolveIdeLaunch(profiled.ide, {}).open;
    }
    return { baseNoIde, profileNoIde };
  } catch {
    return { baseNoIde: true, profileNoIde: {} };
  }
}

export async function loadRepoInfo(
  item: RegistryRepoItem,
  deps: LoadRepoInfoDeps,
): Promise<RepoInfo> {
  if (!deps.pathExists(item.repo_path)) {
    return {
      id: item.id,
      repoPath: item.repo_path,
      project: item.project,
      worktrees: [],
      profileNames: [],
      ideDefaults: { baseNoIde: true, profileNoIde: {} },
      error: "Directory not found",
    };
  }

  const profileNamesPromise = Promise.resolve(
    deps.getProfileNames(item.repo_path),
  );
  const ideDefaultsPromise = deps.getIdeDefaults(item.repo_path);

  let worktreeList: import("../../services/worktree-service").Worktree[];
  let defaultBranch: string | null;
  let profileNames: string[];
  let ideDefaults: IdeDefaults;

  try {
    [profileNames, ideDefaults, worktreeList, defaultBranch] =
      await Promise.all([
        profileNamesPromise,
        ideDefaultsPromise,
        deps.listWorktrees(item.repo_path),
        deps.getDefaultBranch(item.repo_path),
      ]);
  } catch {
    const [fallbackProfileNames, fallbackIdeDefaults] = await Promise.all([
      profileNamesPromise.catch(() => []),
      ideDefaultsPromise.catch(() => ({
        baseNoIde: true,
        profileNoIde: {},
      })),
    ]);
    return {
      id: item.id,
      repoPath: item.repo_path,
      project: item.project,
      worktrees: [],
      profileNames: fallbackProfileNames,
      ideDefaults: fallbackIdeDefaults,
      error: "Failed to inspect repository",
    };
  }

  const worktrees: WorktreeInfo[] = await Promise.all(
    worktreeList
      .filter((wt) => !wt.isBare)
      .map(async (wt, index) => {
        const [changedFiles, sync] = await Promise.all([
          deps.getChangedFileCount(wt.path).catch(() => 0),
          defaultBranch
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
    profileNames,
    ideDefaults,
  };
}

export function useRegistry() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const opts = signal ? { signal } : undefined;
    try {
      const items = await tuiRuntime.runPromise(
        RegistryService.use((s) => s.listRepos()),
        opts,
      );
      const repoInfos: RepoInfo[] = await Promise.all(
        items.map((item) =>
          loadRepoInfo(item, {
            pathExists: existsSync,
            getProfileNames,
            getIdeDefaults,
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
                WorktreeService.use((s) => s.getChangedFileCount(worktreePath)),
                opts,
              ),
            getAheadBehind: (worktreePath, ref) =>
              tuiRuntime.runPromise(
                WorktreeService.use((s) => s.getAheadBehind(worktreePath, ref)),
                opts,
              ),
          }),
        ),
      );
      setRepos(repoInfos);
    } catch {
      // Swallow — previous repos preserved, next poll/watch will retry
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return { repos, loading, refresh };
}

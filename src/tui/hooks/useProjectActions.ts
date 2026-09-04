import { basename } from "node:path";
import type { MutableRefObject } from "react";
import { toWctError } from "../../errors";
import { PrCacheService } from "../../services/pr-cache-service";
import { RegistryService } from "../../services/registry-service";
import { formatSessionName } from "../../services/tmux";
import { WorkspaceService } from "../../services/workspace-service";
import { type LifecycleState, lifecycleBusyMessage } from "../lifecycle";
import { tuiRuntime } from "../runtime";
import { Mode, type TreeItem } from "../types";
import type { RepoInfo } from "./useRegistry";

export interface ProjectActionDeps {
  treeItems: TreeItem[];
  filteredRepos: RepoInfo[];
  repos: RepoInfo[];
  selectedIndex: number;
  mode: Mode;
  lifecycle: LifecycleState;

  setSelectedIndex: (index: number) => void;
  setMode: (mode: Mode) => void;
  showActionError: (message: string) => void;
  clearActionError: () => void;
  refreshAll: () => Promise<RepoInfo[] | null>;
  restoreConfirmationViewport: () => void;
  switchClientAwayFromSessions: (
    sessionNames: readonly string[],
  ) => Promise<boolean>;

  confirmDeleteProjectReturnModeRef: MutableRefObject<Mode>;
  confirmDeleteProjectReturnSelectedIndexRef: MutableRefObject<number>;
}

function restoreProjectUi(deps: ProjectActionDeps) {
  deps.restoreConfirmationViewport();
  deps.setSelectedIndex(
    deps.confirmDeleteProjectReturnSelectedIndexRef.current,
  );
  deps.setMode(deps.confirmDeleteProjectReturnModeRef.current);
}

export function createPrepareDeleteProject(deps: ProjectActionDeps) {
  return () => {
    const item = deps.treeItems[deps.selectedIndex];
    if (item?.type !== "repo") return;

    const filteredRepo = deps.filteredRepos[item.repoIndex];
    const repo = deps.repos.find(
      (candidate) => candidate.repoPath === filteredRepo?.repoPath,
    );
    if (!repo) return;

    for (const active of deps.lifecycle.values()) {
      if (active.repoPath !== repo.repoPath) continue;
      deps.showActionError(lifecycleBusyMessage(active.branch, active.phase));
      return;
    }

    deps.clearActionError();
    deps.confirmDeleteProjectReturnModeRef.current = deps.mode;
    deps.confirmDeleteProjectReturnSelectedIndexRef.current =
      deps.selectedIndex;
    deps.setMode(Mode.ConfirmDeleteProject(repo.repoPath, repo.project));
  };
}

export function createExecuteDeleteProject(deps: ProjectActionDeps) {
  return async (repoPath: string, project: string) => {
    deps.clearActionError();

    try {
      const repo = deps.repos.find(
        (candidate) => candidate.repoPath === repoPath,
      );
      if (!repo) {
        throw new Error(`Project '${project}' is no longer registered`);
      }

      const sessionNames = [
        ...new Set(
          repo.worktrees.map((worktree) =>
            formatSessionName(basename(worktree.path)),
          ),
        ),
      ];
      const canProceed = await deps.switchClientAwayFromSessions(sessionNames);
      if (!canProceed) {
        throw new Error(
          "Cannot safely delete the project because the active tmux client could not be moved away",
        );
      }

      const results = await Promise.allSettled(
        repo.worktrees.map((worktree) =>
          tuiRuntime.runPromise(
            WorkspaceService.use((service) =>
              service.down({ path: worktree.path }),
            ),
          ),
        ),
      );
      const failures = results.flatMap((result, index) => {
        if (result.status === "fulfilled") return [];
        const branch = repo.worktrees[index]?.branch ?? "unknown worktree";
        return [`${branch}: ${toWctError(result.reason).message}`];
      });
      if (failures.length > 0) {
        throw new Error(
          `Failed to stop all sessions for '${project}': ${failures.join("; ")}`,
        );
      }

      await tuiRuntime.runPromise(
        RegistryService.use((service) => service.unregister(repoPath)),
      );
      await tuiRuntime
        .runPromise(
          PrCacheService.use((service) => service.invalidate(project)),
        )
        .catch(() => undefined);
      await deps.refreshAll();
      restoreProjectUi(deps);
    } catch (error) {
      await deps.refreshAll().catch(() => null);
      restoreProjectUi(deps);
      deps.showActionError(toWctError(error).message);
    }
  };
}

export function useProjectActions(deps: ProjectActionDeps) {
  return {
    prepareDeleteProject: createPrepareDeleteProject(deps),
    executeDeleteProject: createExecuteDeleteProject(deps),
  };
}

import { basename } from "node:path";
import { Effect } from "effect";
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
  return (repoPath: string, project: string) => {
    deps.clearActionError();

    const refresh = Effect.tryPromise({
      try: () => deps.refreshAll(),
      catch: toWctError,
    });

    const program = Effect.gen(function* () {
      const repo = deps.repos.find(
        (candidate) => candidate.repoPath === repoPath,
      );
      if (!repo) {
        return yield* Effect.fail(
          toWctError(new Error(`Project '${project}' is no longer registered`)),
        );
      }

      const sessionNames = [
        ...new Set(
          repo.worktrees.map((worktree) =>
            formatSessionName(basename(worktree.path)),
          ),
        ),
      ];
      const canProceed = yield* Effect.tryPromise({
        try: () => deps.switchClientAwayFromSessions(sessionNames),
        catch: toWctError,
      });
      if (!canProceed) {
        return yield* Effect.fail(
          toWctError(
            new Error(
              "Cannot safely delete the project because the active tmux client could not be moved away",
            ),
          ),
        );
      }

      const [failures] = yield* Effect.partition(
        repo.worktrees,
        (worktree) =>
          WorkspaceService.use((service) =>
            service.down({ path: worktree.path }),
          ).pipe(
            Effect.mapError((error) => ({
              branch: worktree.branch,
              error: toWctError(error),
            })),
          ),
        { concurrency: "unbounded" },
      );
      if (failures.length > 0) {
        return yield* Effect.fail(
          toWctError(
            new Error(
              `Failed to stop all sessions for '${project}': ${failures
                .map(({ branch, error }) => `${branch}: ${error.message}`)
                .join("; ")}`,
            ),
          ),
        );
      }

      yield* RegistryService.use((service) => service.unregister(repoPath));
      yield* Effect.ignore(
        PrCacheService.use((service) => service.invalidate(project)),
      );

      const refreshedRepos = yield* refresh;
      if (refreshedRepos === null) {
        return yield* Effect.fail(
          toWctError(
            new Error(
              "Project was deleted, but validation refresh failed — showing the last known project state",
            ),
          ),
        );
      }

      yield* Effect.sync(() => restoreProjectUi(deps));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.ignore(refresh);
          yield* Effect.sync(() => {
            restoreProjectUi(deps);
            deps.showActionError(toWctError(error).message);
          });
        }),
      ),
    );

    return tuiRuntime.runPromise(program);
  };
}

export function useProjectActions(deps: ProjectActionDeps) {
  return {
    prepareDeleteProject: createPrepareDeleteProject(deps),
    executeDeleteProject: createExecuteDeleteProject(deps),
  };
}

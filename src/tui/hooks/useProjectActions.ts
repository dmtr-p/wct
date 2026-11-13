import { Effect } from "effect";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { toWctError } from "../../errors";
import { PrCacheService } from "../../services/pr-cache-service";
import { RegistryService } from "../../services/registry-service";
import { workspaceSessionTarget } from "../../services/session-identity";
import { TmuxService } from "../../services/tmux";
import { WorkspaceService } from "../../services/workspace-service";
import {
  beginLifecycle,
  lifecycleBusyMessage,
  type LifecycleClaims,
  type LifecycleState,
} from "../lifecycle";
import type { TuiLifetime } from "../lifetime";
import { tuiRuntime } from "../runtime";
import type { ReturnSlot } from "../tree-navigation";
import { Mode, type TreeItem } from "../types";
import { formatWorkspaceWarning } from "../workspace-warning";
import type { RepoInfo } from "./useRegistry";

export interface ProjectActionDeps {
  lifetime?: TuiLifetime;
  treeItems: TreeItem[];
  filteredRepos: RepoInfo[];
  repos: RepoInfo[];
  selectedIndex: number;
  mode: Mode;
  lifecycle: LifecycleState;
  lifecycleClaims?: LifecycleClaims;
  setLifecycle?: Dispatch<SetStateAction<LifecycleState>>;

  captureTreeReturnPosition: (slot: ReturnSlot) => void;
  restoreTreeReturnPosition: (slot: ReturnSlot) => void;
  setMode: (mode: Mode) => void;
  showActionError: (message: string) => void;
  clearActionError: () => void;
  refreshAll: () => Promise<RepoInfo[] | null>;
  switchClientAwayFromSessions: (
    sessionNames: readonly string[],
  ) => Promise<boolean>;

  confirmRemoveProjectReturnModeRef: RefObject<Mode>;
}

function restoreProjectUi(deps: ProjectActionDeps) {
  deps.restoreTreeReturnPosition("remove-project");
  deps.setMode(deps.confirmRemoveProjectReturnModeRef.current);
}

export function createPrepareRemoveProject(deps: ProjectActionDeps) {
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
    deps.confirmRemoveProjectReturnModeRef.current = deps.mode;
    deps.captureTreeReturnPosition("remove-project");
    deps.setMode(Mode.ConfirmRemoveProject(repo.repoPath, repo.project));
  };
}

export function createExecuteRemoveProject(deps: ProjectActionDeps) {
  return (repoPath: string, project: string) => {
    deps.clearActionError();

    const refresh = Effect.tryPromise({
      try: () => deps.refreshAll(),
      catch: (error) => toWctError(error),
    });

    const program = Effect.gen(function* () {
      const repo = deps.repos.find(
        (candidate) => candidate.repoPath === repoPath,
      );
      if (!repo) {
        return yield* toWctError(
          new Error(`Project '${project}' is no longer registered`),
        );
      }

      const resolved = yield* Effect.forEach(repo.worktrees, (worktree) =>
        TmuxService.use((service) =>
          service.resolveSession(
            workspaceSessionTarget(repoPath, worktree),
            undefined,
            { readOnly: true },
          ),
        ),
      );
      const sessionNames = resolved.flatMap((session) =>
        session ? [session.name] : [],
      );
      const canProceed = yield* Effect.tryPromise({
        try: () => deps.switchClientAwayFromSessions(sessionNames),
        catch: (error) => toWctError(error),
      });
      if (!canProceed) {
        return yield* toWctError(
          new Error(
            "Cannot safely remove the project because the active tmux client could not be moved away",
          ),
        );
      }

      const [stopped, failures] = yield* Effect.partition(
        repo.worktrees,
        (worktree) =>
          Effect.acquireUseRelease(
            Effect.sync(() =>
              deps.lifecycleClaims && deps.setLifecycle
                ? beginLifecycle({
                    claims: deps.lifecycleClaims,
                    setLifecycle: deps.setLifecycle,
                    entry: {
                      operation: "down",
                      repoPath,
                      project,
                      branch: worktree.branch,
                      phase: { _tag: "Preparing" },
                    },
                    showActionError: deps.showActionError,
                  })
                : undefined,
            ),
            (lifecycle) =>
              lifecycle === null
                ? Effect.fail(
                    toWctError(
                      new Error(
                        `Workspace '${worktree.branch}' is already busy`,
                      ),
                    ),
                  )
                : WorkspaceService.use((service) =>
                    service.down({
                      path: worktree.path,
                      expectedTarget: workspaceSessionTarget(
                        repoPath,
                        worktree,
                      ),
                      ...(lifecycle ? { reporter: lifecycle.reporter } : {}),
                    }),
                  ),
            (lifecycle) => Effect.sync(() => lifecycle?.end()),
          ).pipe(
            Effect.mapError((error) => ({
              branch: worktree.branch,
              error: toWctError(error),
            })),
          ),
        { concurrency: "unbounded" },
      );
      if (failures.length > 0) {
        return yield* toWctError(
          new Error(
            `Failed to stop all sessions for '${project}': ${failures
              .map(({ branch, error }) => `${branch}: ${error.message}`)
              .join("; ")}`,
          ),
        );
      }

      yield* RegistryService.use((service) => service.unregister(repoPath));
      yield* Effect.ignore(
        PrCacheService.use((service) => service.invalidate(repoPath)),
      );

      const refreshedRepos = yield* refresh;
      if (refreshedRepos === null) {
        return yield* toWctError(
          new Error(
            "Project was removed from the registry, but validation refresh failed — showing the last known project state",
          ),
        );
      }

      yield* Effect.sync(() => {
        restoreProjectUi(deps);
        const warnings = stopped.flatMap((result) =>
          result.warnings.map(formatWorkspaceWarning),
        );
        if (warnings.length > 0) deps.showActionError(warnings.join("; "));
      });
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

    if (deps.lifetime?.closing) return Promise.resolve();
    return deps.lifetime
      ? deps.lifetime.track(() => tuiRuntime.runPromise(program))
      : tuiRuntime.runPromise(program);
  };
}

export function useProjectActions(deps: ProjectActionDeps) {
  return {
    prepareRemoveProject: createPrepareRemoveProject(deps),
    executeRemoveProject: createExecuteRemoveProject(deps),
  };
}

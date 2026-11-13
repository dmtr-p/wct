import type { Dispatch, RefObject, SetStateAction } from "react";
import { toWctError } from "../../errors";
import type { WorkspaceIdentityKey } from "../../services/identities";
import {
  findWorkspaceSession,
  workspaceSessionName,
  type WorkspaceSessionTarget,
  workspaceSessionTarget,
} from "../../services/session-identity";
import type { TmuxClient } from "../../services/tmux";
import {
  type WorkspaceCloseResult,
  type WorkspaceDownResult,
  WorkspaceService,
  type WorkspaceUpResult,
} from "../../services/workspace-service";
import {
  captureWorkspaceConfirmation,
  type WorkspaceConfirmation,
} from "../../services/workspace-target";
import {
  closeRetentionMessage,
  type LifecycleClaims,
  type LifecycleState,
  rejectIfLifecycleActive as refuseWhenLifecycleActive,
  runLifecycleOperation,
  workspaceIdentityKey,
} from "../lifecycle";
import { tuiRuntime } from "../runtime";
import {
  createSessionHandoff,
  type SessionHandoffDeps,
} from "../session-handoff";
import {
  resolveSessionsHandoff,
  resolveStartActionMessage,
} from "../session-utils";
import { resolveSelectedWorktreeTarget } from "../tree-helpers";
import type { ReturnDestination, ReturnSlot } from "../tree-navigation";
import { Mode, type TreeItem } from "../types";
import { formatWorkspaceWarning } from "../workspace-warning";
import type { RepoInfo, WorktreeInfo } from "./useRegistry";
import type { TmuxClientDiscovery, TmuxSessionInfo } from "./useTmux";

export interface SessionActionDeps extends SessionHandoffDeps {
  treeItems: TreeItem[];
  filteredRepos: RepoInfo[];
  sessions: TmuxSessionInfo[];
  selectedIndex: number;
  mode: Mode;
  lifecycle: LifecycleState;
  lifecycleClaims: LifecycleClaims;

  captureTreeReturnPosition: (
    slot: ReturnSlot,
    preserveSelection?: boolean,
  ) => void;
  restoreTreeReturnPosition: (
    slot: ReturnSlot,
    destination?: ReturnDestination,
  ) => void;
  setMode: (m: Mode) => void;
  modeRef: RefObject<Mode>;
  setLifecycle: Dispatch<SetStateAction<LifecycleState>>;

  showActionError: (msg: string) => void;
  clearActionError: () => void;

  detachClient: (client?: TmuxClient | null) => Promise<boolean>;
  discoverClient: (signal?: AbortSignal) => Promise<TmuxClientDiscovery>;
  refreshSessions: (signal?: AbortSignal) => Promise<TmuxSessionInfo[]>;

  refreshAll: () => Promise<RepoInfo[] | null>;
  confirmDownReturnModeRef: RefObject<Mode>;
  confirmCloseReturnModeRef: RefObject<Mode>;
}

function rejectIfLifecycleActive(
  deps: SessionActionDeps,
  repoPath: string,
  branch: string,
): boolean {
  return refuseWhenLifecycleActive({
    lifecycle: deps.lifecycle,
    mainRepoPath: repoPath,
    branch,
    showActionError: deps.showActionError,
  });
}

export function createSwitchClientAway(deps: SessionActionDeps) {
  const switchAwayFromSessions = createSwitchClientAwayFromSessions(deps);
  return (sessionName: string, target?: WorkspaceSessionTarget) =>
    switchAwayFromSessions([sessionName], target ? [target] : undefined);
}

export function createSwitchClientAwayFromSessions(deps: SessionActionDeps) {
  return async (
    sessionNames: readonly string[],
    targets?: readonly WorkspaceSessionTarget[],
  ): Promise<boolean> => {
    try {
      // Attach both rejection handlers before a dependency can throw synchronously.
      const [client, latestSessions] = await Promise.all([
        Promise.resolve().then(() => deps.discoverClient()),
        Promise.resolve().then(() => deps.refreshSessions()),
      ]);
      const handoff = resolveSessionsHandoff({
        client,
        targetSessions: targets
          ? targets.map(
              (target, index) =>
                findWorkspaceSession(latestSessions, target)?.name ??
                sessionNames[index] ??
                workspaceSessionName(target),
            )
          : sessionNames,
        sessions: latestSessions,
      });

      if (handoff.type === "not-needed") {
        return true;
      }

      if (handoff.type === "blocked" || client.type !== "single") {
        return false;
      }

      if (handoff.type === "detach") {
        return await deps.detachClient(client.client);
      }

      return (
        (await deps.switchSession(handoff.sessionName, client.client)) === true
      );
    } catch {
      return false;
    }
  };
}

export interface StartWorkspaceTarget {
  worktreePath: string;
  repoPath: string;
  project: string;
  branch: string;
  profile?: string;
  autoSwitch: boolean;
}

export function createStartWorkspace(deps: SessionActionDeps) {
  const sessionHandoff = createSessionHandoff(deps);

  return (target: StartWorkspaceTarget): Promise<void> =>
    runLifecycleOperation<WorkspaceUpResult>({
      claims: deps.lifecycleClaims,
      setLifecycle: deps.setLifecycle,
      refreshAll: deps.refreshAll,
      showActionError: deps.showActionError,
      entry: {
        operation: "up",
        repoPath: target.repoPath,
        project: target.project,
        branch: target.branch,
        phase: { _tag: "Preparing" },
      },
      run: (reporter) =>
        tuiRuntime.runPromise(
          WorkspaceService.use((service) =>
            service.up({
              path: target.worktreePath,
              ...(target.profile ? { profile: target.profile } : {}),
              reporter,
            }),
          ),
        ),
      resultWarnings: (result) => {
        const message = resolveStartActionMessage(result);
        return message ? [message] : [];
      },
      afterCleanup: (result) =>
        sessionHandoff({
          repoPath: target.repoPath,
          branch: target.branch,
          sessionName: result.sessionName,
          target: workspaceSessionTarget(target.repoPath, {
            path: target.worktreePath,
            branch: target.branch,
          }),
          tmux: result.attempts.tmux,
          autoSwitch: target.autoSwitch,
          wording: { action: "start", completed: "Started" },
        }),
    });
}

export function createHandleSpaceSwitch(deps: SessionActionDeps) {
  const startWorkspace = createStartWorkspace(deps);

  return () => {
    const item = deps.treeItems[deps.selectedIndex];
    if (!item) return;

    if (item.type === "detail" && item.action) {
      item.action();
      return;
    }

    const target = resolveSelectedWorktreeTarget(
      deps.filteredRepos,
      deps.treeItems,
      deps.selectedIndex,
    );
    if (!target) return;
    const { repo, worktree: wt } = target;
    if (rejectIfLifecycleActive(deps, repo.repoPath, wt.branch)) return;
    const sessionName =
      findWorkspaceSession(
        deps.sessions,
        workspaceSessionTarget(repo.repoPath, wt),
      )?.name ??
      workspaceSessionName(workspaceSessionTarget(repo.repoPath, wt));
    const hasSession = !!findWorkspaceSession(
      deps.sessions,
      workspaceSessionTarget(repo.repoPath, wt),
    );
    if (hasSession) {
      deps.clearActionError();
      const run = () =>
        deps
          .switchSession(
            sessionName,
            undefined,
            workspaceSessionTarget(repo.repoPath, wt),
          )
          .then((switched) => {
            if (switched === false) {
              deps.showActionError(
                `Failed to switch to tmux session '${sessionName}'`,
              );
            }
          })
          .catch((error) => {
            deps.showActionError(
              `Failed to switch to tmux session '${sessionName}': ${toWctError(error).message}`,
            );
          });
      const lifetime = deps.lifecycleClaims.lifetime;
      if (lifetime?.closing) return;
      void (lifetime ? lifetime.track(run) : run());
    } else {
      deps.clearActionError();
      void startWorkspace({
        worktreePath: wt.path,
        repoPath: repo.repoPath,
        project: repo.project,
        branch: wt.branch,
        autoSwitch: true,
      });
    }
  };
}

export function createExecuteDown(deps: SessionActionDeps) {
  const switchClientAway = createSwitchClientAway(deps);

  return async (
    sessionName: string,
    branch: string,
    worktreePath: string,
    repoPath: string,
    project: string,
    confirmation?: WorkspaceConfirmation,
  ) => {
    deps.clearActionError();

    await runLifecycleOperation<WorkspaceDownResult>({
      claims: deps.lifecycleClaims,
      setLifecycle: deps.setLifecycle,
      refreshAll: deps.refreshAll,
      showActionError: deps.showActionError,
      resultWarnings: (result) => result.warnings.map(formatWorkspaceWarning),
      entry: {
        operation: "down",
        repoPath,
        project,
        branch,
        phase: { _tag: "Preparing" },
      },
      run: async (reporter) => {
        const canProceed = await switchClientAway(sessionName, {
          mainRepoPath: repoPath,
          worktreePath,
          branch,
        });
        if (!canProceed) {
          throw new Error(
            "Cannot safely stop the tmux session because the active client could not be moved away",
          );
        }

        deps.restoreTreeReturnPosition("down", "owning-worktree");
        deps.setMode(deps.confirmDownReturnModeRef.current);

        return tuiRuntime.runPromise(
          WorkspaceService.use((service) =>
            service.down({
              path: worktreePath,
              reporter,
              ...(confirmation ? { confirmation } : {}),
            }),
          ),
        );
      },
    });
  };
}

export function createHandleCloseSelectedWorktree(deps: SessionActionDeps) {
  const handleCloseWorktree = createHandleCloseWorktree(deps);
  return () => {
    const target = resolveSelectedWorktreeTarget(
      deps.filteredRepos,
      deps.treeItems,
      deps.selectedIndex,
    );
    if (!target) return;
    handleCloseWorktree(target.repo, target.worktree);
  };
}

export function createHandleCloseWorktree(deps: SessionActionDeps) {
  return (repo: RepoInfo, wt: WorktreeInfo, agentItemId?: string) => {
    if (rejectIfLifecycleActive(deps, repo.repoPath, wt.branch)) return;

    const sessionName =
      findWorkspaceSession(
        deps.sessions,
        workspaceSessionTarget(repo.repoPath, wt),
      )?.name ??
      workspaceSessionName(workspaceSessionTarget(repo.repoPath, wt));
    const workspaceKey = workspaceIdentityKey(repo.repoPath, wt.branch);
    if (!agentItemId) deps.captureTreeReturnPosition("close");
    deps.confirmCloseReturnModeRef.current = agentItemId
      ? deps.mode
      : deps.mode.type === "Expanded"
        ? Mode.Expanded(workspaceKey)
        : Mode.Navigate;
    const mode = Mode.ConfirmClose(
      sessionName,
      wt.branch,
      wt.path,
      workspaceKey,
      repo.repoPath,
      repo.project,
      wt.changedFiles,
      agentItemId,
    );
    try {
      if (mode.type === "ConfirmClose")
        mode.confirmation = captureWorkspaceConfirmation(
          workspaceSessionTarget(repo.repoPath, wt),
          findWorkspaceSession(
            deps.sessions,
            workspaceSessionTarget(repo.repoPath, wt),
          ) ?? null,
        );
      deps.setMode(mode);
    } catch (error) {
      deps.showActionError(toWctError(error).message);
    }
  };
}

export function createExecuteClose(deps: SessionActionDeps) {
  const switchClientAway = createSwitchClientAway(deps);

  return async (
    sessionName: string,
    branch: string,
    worktreePath: string,
    workspaceKey: WorkspaceIdentityKey,
    repoPath: string,
    project: string,
    force: boolean,
    agentItemId?: string,
    previousClose?: WorkspaceCloseResult,
    confirmation?: WorkspaceConfirmation,
  ) => {
    deps.clearActionError();
    const restoredMode = deps.confirmCloseReturnModeRef.current;

    await runLifecycleOperation<WorkspaceCloseResult>({
      claims: deps.lifecycleClaims,
      setLifecycle: deps.setLifecycle,
      refreshAll: deps.refreshAll,
      showActionError: deps.showActionError,
      resultWarnings: (result) => result.warnings.map(formatWorkspaceWarning),
      entry: {
        operation: "close",
        repoPath,
        project,
        branch,
        phase: { _tag: "Preparing" },
      },
      run: async (reporter) => {
        const canProceed = await switchClientAway(sessionName, {
          mainRepoPath: repoPath,
          worktreePath,
          branch,
        });
        if (!canProceed) {
          throw new Error(
            "Cannot safely close the worktree because the active tmux client could not be moved away",
          );
        }

        if (!agentItemId)
          deps.restoreTreeReturnPosition("close", "owning-worktree");
        deps.setMode(restoredMode);

        return tuiRuntime.runPromise(
          WorkspaceService.use((service) =>
            previousClose
              ? service.retryCloseRemoval(previousClose, { reporter })
              : service.close(
                  force
                    ? {
                        path: worktreePath,
                        cwd: repoPath,
                        force,
                        reporter,
                        ...(confirmation ? { confirmation } : {}),
                      }
                    : {
                        path: worktreePath,
                        cwd: repoPath,
                        reporter,
                        ...(confirmation ? { confirmation } : {}),
                      },
                ),
          ),
        );
      },
      // Force confirmation needs a stable tree and a released lifecycle claim.
      afterCleanup: async (result) => {
        if (result.status !== "blocked_by_changes") return undefined;
        if (
          deps.lifecycleClaims.lifetime?.closing ||
          deps.isPresentationActive?.() === false
        ) {
          return closeRetentionMessage(branch);
        }
        // Avoid replacing a mode the user entered while validation was in flight.
        if (deps.modeRef.current !== restoredMode) {
          return `Worktree '${branch}' has uncommitted changes — press c to close it with force`;
        }
        if (!agentItemId) deps.captureTreeReturnPosition("close", true);
        const forceMode = Mode.ConfirmCloseForce(
          sessionName,
          branch,
          worktreePath,
          workspaceKey,
          repoPath,
          project,
          agentItemId,
        );
        if (forceMode.type === "ConfirmCloseForce")
          forceMode.previousClose = result;
        // Quit can arrive before React commits the deferred confirmation.
        deps.modeRef.current = forceMode;
        deps.setMode(forceMode);
        return undefined;
      },
    });
  };
}

export function createHandleDownSelectedWorktree(deps: SessionActionDeps) {
  return () => {
    const target = resolveSelectedWorktreeTarget(
      deps.filteredRepos,
      deps.treeItems,
      deps.selectedIndex,
    );
    if (!target) return;
    const { repo, worktree: wt } = target;

    if (rejectIfLifecycleActive(deps, repo.repoPath, wt.branch)) return;

    const sessionName =
      findWorkspaceSession(
        deps.sessions,
        workspaceSessionTarget(repo.repoPath, wt),
      )?.name ??
      workspaceSessionName(workspaceSessionTarget(repo.repoPath, wt));
    const workspaceKey = workspaceIdentityKey(repo.repoPath, wt.branch);
    deps.captureTreeReturnPosition("down");
    deps.confirmDownReturnModeRef.current =
      deps.mode.type === "Expanded"
        ? Mode.Expanded(workspaceKey)
        : Mode.Navigate;
    const mode = Mode.ConfirmDown({
      sessionName,
      branch: wt.branch,
      worktreePath: wt.path,
      workspaceKey,
      repoPath: repo.repoPath,
      project: repo.project,
    });
    try {
      if (mode.type === "ConfirmDown")
        mode.confirmation = captureWorkspaceConfirmation(
          workspaceSessionTarget(repo.repoPath, wt),
          findWorkspaceSession(
            deps.sessions,
            workspaceSessionTarget(repo.repoPath, wt),
          ) ?? null,
        );
      deps.setMode(mode);
    } catch (error) {
      deps.showActionError(toWctError(error).message);
    }
  };
}

export function useSessionActions(deps: SessionActionDeps) {
  return {
    switchClientAwayFromSessions: createSwitchClientAwayFromSessions(deps),
    startWorkspace: createStartWorkspace(deps),
    handleSpaceSwitch: createHandleSpaceSwitch(deps),
    handleCloseSelectedWorktree: createHandleCloseSelectedWorktree(deps),
    handleCloseWorktree: createHandleCloseWorktree(deps),
    executeClose: createExecuteClose(deps),
    handleDownSelectedWorktree: createHandleDownSelectedWorktree(deps),
    executeDown: createExecuteDown(deps),
  };
}

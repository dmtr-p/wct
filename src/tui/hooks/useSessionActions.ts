import { basename } from "node:path";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { toWctError } from "../../errors";
import type { TmuxClient } from "../../services/tmux";
import { formatSessionName } from "../../services/tmux";
import {
  type WorkspaceCloseResult,
  type WorkspaceDownResult,
  WorkspaceService,
  type WorkspaceUpResult,
} from "../../services/workspace-service";
import {
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
import { resolveSelectedWorktreeIndex } from "../tree-helpers";
import type { ReturnDestination, ReturnSlot } from "../tree-navigation";
import { Mode, type TreeItem } from "../types";
import { formatWorkspaceWarning } from "../workspace-warning";
import type { RepoInfo } from "./useRegistry";
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

  switchSession: (name: string, client?: TmuxClient | null) => Promise<boolean>;
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
  return (sessionName: string) => switchAwayFromSessions([sessionName]);
}

export function createSwitchClientAwayFromSessions(deps: SessionActionDeps) {
  return async (sessionNames: readonly string[]): Promise<boolean> => {
    try {
      // Attach both rejection handlers before a dependency can throw synchronously.
      const [client, latestSessions] = await Promise.all([
        Promise.resolve().then(() => deps.discoverClient()),
        Promise.resolve().then(() => deps.refreshSessions()),
      ]);
      const handoff = resolveSessionsHandoff({
        client,
        targetSessions: sessionNames,
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

      return await deps.switchSession(handoff.sessionName, client.client);
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

    const worktreeIndex = resolveSelectedWorktreeIndex(
      deps.treeItems,
      deps.selectedIndex,
    );
    if (worktreeIndex === null) return;

    const resolvedItem = deps.treeItems[worktreeIndex];
    if (resolvedItem?.type !== "worktree") return;
    const repo = deps.filteredRepos[resolvedItem.repoIndex];
    if (!repo) return;
    const wt = repo.worktrees[resolvedItem.worktreeIndex];
    if (!wt) return;
    if (rejectIfLifecycleActive(deps, repo.repoPath, wt.branch)) return;
    const sessionName = formatSessionName(basename(wt.path));
    const hasSession = deps.sessions.some((s) => s.name === sessionName);
    if (hasSession) {
      deps.clearActionError();
      void deps
        .switchSession(sessionName)
        .then((switched) => {
          if (!switched) {
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
        const canProceed = await switchClientAway(sessionName);
        if (!canProceed) {
          throw new Error(
            "Cannot safely stop the tmux session because the active client could not be moved away",
          );
        }

        deps.restoreTreeReturnPosition("down", "owning-worktree");
        deps.setMode(deps.confirmDownReturnModeRef.current);

        return tuiRuntime.runPromise(
          WorkspaceService.use((service) =>
            service.down({ path: worktreePath, reporter }),
          ),
        );
      },
    });
  };
}

export function createHandleCloseSelectedWorktree(deps: SessionActionDeps) {
  return () => {
    const worktreeIndex = resolveSelectedWorktreeIndex(
      deps.treeItems,
      deps.selectedIndex,
    );
    if (worktreeIndex === null) return;

    const item = deps.treeItems[worktreeIndex];
    if (item?.type !== "worktree") return;

    const repo = deps.filteredRepos[item.repoIndex];
    const wt = repo?.worktrees[item.worktreeIndex];
    if (!repo || !wt) return;

    if (rejectIfLifecycleActive(deps, repo.repoPath, wt.branch)) return;

    const sessionName = formatSessionName(basename(wt.path));
    const workspaceKey = workspaceIdentityKey(repo.repoPath, wt.branch);
    deps.captureTreeReturnPosition("close");
    deps.confirmCloseReturnModeRef.current =
      deps.mode.type === "Expanded"
        ? Mode.Expanded(workspaceKey)
        : Mode.Navigate;
    deps.setMode(
      Mode.ConfirmClose(
        sessionName,
        wt.branch,
        wt.path,
        workspaceKey,
        repo.repoPath,
        repo.project,
        wt.changedFiles,
      ),
    );
  };
}

export function createExecuteClose(deps: SessionActionDeps) {
  const switchClientAway = createSwitchClientAway(deps);

  return async (
    sessionName: string,
    branch: string,
    worktreePath: string,
    workspaceKey: string,
    repoPath: string,
    project: string,
    force: boolean,
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
        const canProceed = await switchClientAway(sessionName);
        if (!canProceed) {
          throw new Error(
            "Cannot safely close the worktree because the active tmux client could not be moved away",
          );
        }

        deps.restoreTreeReturnPosition("close", "owning-worktree");
        deps.setMode(restoredMode);

        return tuiRuntime.runPromise(
          WorkspaceService.use((service) =>
            service.close(
              force
                ? { path: worktreePath, cwd: repoPath, force, reporter }
                : { path: worktreePath, cwd: repoPath, reporter },
            ),
          ),
        );
      },
      // Force confirmation needs a stable tree and a released lifecycle claim.
      afterCleanup: async (result) => {
        if (result.status !== "blocked_by_changes") return undefined;
        // Avoid replacing a mode the user entered while validation was in flight.
        if (deps.modeRef.current !== restoredMode) {
          return `Worktree '${branch}' has uncommitted changes — press c to close it with force`;
        }
        deps.captureTreeReturnPosition("close", true);
        deps.setMode(
          Mode.ConfirmCloseForce(
            sessionName,
            branch,
            worktreePath,
            workspaceKey,
            repoPath,
            project,
          ),
        );
        return undefined;
      },
    });
  };
}

export function createHandleDownSelectedWorktree(deps: SessionActionDeps) {
  return () => {
    const worktreeIndex = resolveSelectedWorktreeIndex(
      deps.treeItems,
      deps.selectedIndex,
    );
    if (worktreeIndex === null) return;

    const item = deps.treeItems[worktreeIndex];
    if (item?.type !== "worktree") return;

    const repo = deps.filteredRepos[item.repoIndex];
    const wt = repo?.worktrees[item.worktreeIndex];
    if (!repo || !wt) return;

    if (rejectIfLifecycleActive(deps, repo.repoPath, wt.branch)) return;

    const sessionName = formatSessionName(basename(wt.path));
    const workspaceKey = workspaceIdentityKey(repo.repoPath, wt.branch);
    deps.captureTreeReturnPosition("down");
    deps.confirmDownReturnModeRef.current =
      deps.mode.type === "Expanded"
        ? Mode.Expanded(workspaceKey)
        : Mode.Navigate;
    deps.setMode(
      Mode.ConfirmDown({
        sessionName,
        branch: wt.branch,
        worktreePath: wt.path,
        workspaceKey,
        repoPath: repo.repoPath,
        project: repo.project,
      }),
    );
  };
}

export function useSessionActions(deps: SessionActionDeps) {
  return {
    switchClientAwayFromSessions: createSwitchClientAwayFromSessions(deps),
    startWorkspace: createStartWorkspace(deps),
    handleSpaceSwitch: createHandleSpaceSwitch(deps),
    handleCloseSelectedWorktree: createHandleCloseSelectedWorktree(deps),
    executeClose: createExecuteClose(deps),
    handleDownSelectedWorktree: createHandleDownSelectedWorktree(deps),
    executeDown: createExecuteDown(deps),
  };
}

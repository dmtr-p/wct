// src/tui/hooks/useSessionActions.ts

import { basename } from "node:path";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
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
  isLifecycleActive,
  type LifecycleClaims,
  type LifecycleState,
  lifecycleBusyMessage,
  lifecycleEntryFor,
  runLifecycleOperation,
} from "../lifecycle";
import { tuiRuntime } from "../runtime";
import {
  resolveSessionHandoff,
  resolveStartActionMessage,
} from "../session-utils";
import { isInertTreeItem, resolveSelectedWorktreeIndex } from "../tree-helpers";
import { Mode, pendingKey, type TreeItem } from "../types";
import type { RepoInfo } from "./useRegistry";
import type { TmuxClientDiscovery, TmuxSessionInfo } from "./useTmux";

export interface SessionActionDeps {
  treeItems: TreeItem[];
  filteredRepos: RepoInfo[];
  sessions: TmuxSessionInfo[];
  selectedIndex: number;
  mode: Mode;
  /** Active lifecycle operations, keyed by Workspace Identity. */
  lifecycle: LifecycleState;
  /**
   * The synchronous claim ledger arbitrating Workspace Identities. Shared with
   * every other lifecycle-driving hook, because it is what makes a second
   * operation for one identity impossible rather than merely unlikely.
   */
  lifecycleClaims: LifecycleClaims;

  setSelectedIndex: Dispatch<SetStateAction<number>>;
  setMode: (m: Mode) => void;
  /**
   * The LIVE mode, readable from async continuations. `mode` above is a
   * render-time capture and is stale by the time a lifecycle settles, so an
   * operation that wants to present something on completion has to ask this
   * whether the user is still where the operation left them.
   */
  modeRef: MutableRefObject<Mode>;
  setLifecycle: Dispatch<SetStateAction<LifecycleState>>;

  showActionError: (msg: string) => void;
  clearActionError: () => void;

  switchSession: (name: string, client?: TmuxClient | null) => Promise<boolean>;
  detachClient: (client?: TmuxClient | null) => Promise<boolean>;
  discoverClient: (signal?: AbortSignal) => Promise<TmuxClientDiscovery>;
  refreshSessions: (signal?: AbortSignal) => Promise<TmuxSessionInfo[]>;

  /**
   * Resolves the registry snapshot the refresh observed, or `null` when it
   * failed (previous repos kept).
   */
  refreshAll: () => Promise<RepoInfo[] | null>;
  restoreConfirmationViewport: () => void;

  confirmDownReturnModeRef: MutableRefObject<Mode>;
  confirmDownReturnSelectedIndexRef: MutableRefObject<number>;
  confirmCloseReturnModeRef: MutableRefObject<Mode>;
  confirmCloseReturnSelectedIndexRef: MutableRefObject<number>;
}

/**
 * A Workspace under an active lifecycle is INERT TO ACTIONS but still
 * selectable and arrow-key reachable: only its actions are refused, and the
 * refusal is reported through the existing timed error display. The single
 * shared guard, so every action entry point rejects on the same condition.
 */
function rejectIfLifecycleActive(
  deps: SessionActionDeps,
  repoPath: string,
  branch: string,
): boolean {
  if (!isLifecycleActive(deps.lifecycle, repoPath, branch)) return false;
  deps.showActionError(
    lifecycleBusyMessage(
      branch,
      lifecycleEntryFor(deps.lifecycle, repoPath, branch)?.phase,
    ),
  );
  return true;
}

export function createNavigateTree(deps: SessionActionDeps) {
  return (direction: 1 | -1) => {
    deps.setSelectedIndex((prev) => {
      let next = prev + direction;
      while (next >= 0 && next < deps.treeItems.length) {
        if (isInertTreeItem(deps.treeItems[next])) {
          next += direction;
          continue;
        }
        return next;
      }
      return prev;
    });
  };
}

export function createSwitchClientAway(deps: SessionActionDeps) {
  return async (sessionName: string) => {
    try {
      const [client, latestSessions] = await Promise.all([
        deps.discoverClient(),
        deps.refreshSessions(),
      ]);
      const handoff = resolveSessionHandoff({
        client,
        targetSession: sessionName,
        sessions: latestSessions,
      });

      if (handoff.type === "not-needed") {
        return true;
      }

      if (handoff.type === "blocked") {
        return false;
      }

      if (handoff.type === "detach") {
        return client.type === "single"
          ? await deps.detachClient(client.client)
          : false;
      }

      return client.type === "single"
        ? await deps.switchSession(handoff.sessionName, client.client)
        : false;
    } catch {
      return false;
    }
  };
}

/** What one `up` needs to know: the Workspace Identity plus the run options. */
export interface StartWorkspaceTarget {
  worktreePath: string;
  /** Main repository path — one half of the Workspace Identity. */
  repoPath: string;
  project: string;
  branch: string;
  profile?: string;
  autoSwitch: boolean;
}

/**
 * The automatic tmux hand-off after a start. Runs LAST — after validation and
 * after the lifecycle presentation is gone — because switching detaches the
 * terminal this TUI is drawn in, and a failed switch must surface as a plain
 * action error rather than resurrecting a progress row. Returns the message to
 * report, or `undefined` when there is nothing to say.
 */
export function createSessionHandoff(deps: SessionActionDeps) {
  return async (
    result: WorkspaceUpResult,
    autoSwitch: boolean,
  ): Promise<string | undefined> => {
    if (!autoSwitch) return undefined;
    if (!(result.attempts.tmux.attempted && result.attempts.tmux.ok)) {
      return undefined;
    }

    const liveClient = await deps.discoverClient();
    if (liveClient.type !== "single") return undefined;

    const switched = await deps.switchSession(
      result.sessionName,
      liveClient.client,
    );
    await deps.refreshSessions();
    return switched
      ? undefined
      : `Started session '${result.sessionName}', but failed to switch client`;
  };
}

/**
 * The ONE `up` path, shared by the space-bar start and the up modal: begin a
 * lifecycle for the Workspace Identity, run the service with the reporter that
 * drives the progress row so only phases actually attempted are shown, then
 * validate, tear down and hand off.
 */
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
      afterCleanup: (result) => sessionHandoff(result, target.autoSwitch),
    });
}

export function createHandleSpaceSwitch(deps: SessionActionDeps) {
  const startWorkspace = createStartWorkspace(deps);

  return () => {
    const item = deps.treeItems[deps.selectedIndex];
    if (!item) return;

    // For any detail row with an action, fire it (pane jump, PR open, etc.)
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

    const canProceed = await switchClientAway(sessionName);
    if (!canProceed) {
      deps.showActionError(
        "Cannot safely stop the tmux session because the active client could not be moved away",
      );
      return;
    }

    deps.restoreConfirmationViewport();
    deps.setSelectedIndex(deps.confirmDownReturnSelectedIndexRef.current);
    deps.setMode(deps.confirmDownReturnModeRef.current);

    await runLifecycleOperation<WorkspaceDownResult>({
      claims: deps.lifecycleClaims,
      setLifecycle: deps.setLifecycle,
      refreshAll: deps.refreshAll,
      showActionError: deps.showActionError,
      entry: {
        operation: "down",
        repoPath,
        project,
        branch,
        phase: { _tag: "Preparing" },
      },
      run: (reporter) =>
        tuiRuntime.runPromise(
          WorkspaceService.use((service) =>
            service.down({ path: worktreePath, reporter }),
          ),
        ),
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
    const worktreeKey = pendingKey(repo.project, wt.branch);
    deps.confirmCloseReturnSelectedIndexRef.current = deps.selectedIndex;
    deps.confirmCloseReturnModeRef.current =
      deps.mode.type === "Expanded"
        ? Mode.Expanded(worktreeKey)
        : Mode.Navigate;
    deps.setMode(
      Mode.ConfirmClose(
        sessionName,
        wt.branch,
        wt.path,
        worktreeKey,
        repo.repoPath,
        repo.project,
        wt.changedFiles,
      ),
    );
  };
}

/**
 * The ONE `close` path. Session teardown and filesystem teardown are distinct
 * phases (`Killing tmux session…`, `Removing worktree…`), and EVERY outcome —
 * removed, refused by git, or fatally failed — goes through the same
 * `Validating Workspace…` step before the Workspace is removed from the tree or
 * unlocked, so a closed Workspace never disappears optimistically.
 */
export function createExecuteClose(deps: SessionActionDeps) {
  const switchClientAway = createSwitchClientAway(deps);

  return async (
    sessionName: string,
    branch: string,
    worktreePath: string,
    worktreeKey: string,
    repoPath: string,
    project: string,
    force: boolean,
  ) => {
    deps.clearActionError();

    const canProceed = await switchClientAway(sessionName);
    if (!canProceed) {
      deps.showActionError(
        "Cannot safely close the worktree because the active tmux client could not be moved away",
      );
      return;
    }

    deps.restoreConfirmationViewport();
    deps.setSelectedIndex(deps.confirmCloseReturnSelectedIndexRef.current);
    const restoredMode = deps.confirmCloseReturnModeRef.current;
    deps.setMode(restoredMode);

    await runLifecycleOperation<WorkspaceCloseResult>({
      claims: deps.lifecycleClaims,
      setLifecycle: deps.setLifecycle,
      refreshAll: deps.refreshAll,
      showActionError: deps.showActionError,
      entry: {
        operation: "close",
        repoPath,
        project,
        branch,
        phase: { _tag: "Preparing" },
      },
      run: (reporter) =>
        tuiRuntime.runPromise(
          WorkspaceService.use((service) =>
            service.close(
              force
                ? { path: worktreePath, cwd: repoPath, force, reporter }
                : { path: worktreePath, cwd: repoPath, reporter },
            ),
          ),
        ),
      // A close git refused is not an outcome to report — it is a question to
      // ask. Asking it from `afterCleanup` means the current lifecycle
      // presentation is COMPLETELY over first (validation finished, progress
      // row gone, expansion back to the user's own preference), so the
      // confirmation is anchored against a stable tree and the forced retry
      // starts a fresh lifecycle rather than inheriting a stale phase or lock.
      afterCleanup: async (result) => {
        if (result.status !== "blocked_by_changes") return undefined;
        // Validation takes as long as a registry refresh takes, and the user is
        // free to move on while it runs — into search, a modal, another
        // confirmation. The question is only ASKED if the tree is still in the
        // mode this close restored; otherwise it is merely reported, so the
        // refusal is never silent and never discards what the user is typing.
        if (deps.modeRef.current !== restoredMode) {
          return `Worktree '${branch}' has uncommitted changes — press c to close it with force`;
        }
        deps.setMode(
          Mode.ConfirmCloseForce(
            sessionName,
            branch,
            worktreePath,
            worktreeKey,
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
    const hasSession = deps.sessions.some((s) => s.name === sessionName);
    if (!hasSession) return;

    const worktreeKey = pendingKey(repo.project, wt.branch);
    deps.confirmDownReturnSelectedIndexRef.current = deps.selectedIndex;
    deps.confirmDownReturnModeRef.current =
      deps.mode.type === "Expanded"
        ? Mode.Expanded(worktreeKey)
        : Mode.Navigate;
    deps.setMode(
      Mode.ConfirmDown(
        sessionName,
        wt.branch,
        wt.path,
        worktreeKey,
        repo.repoPath,
        repo.project,
      ),
    );
  };
}

export function useSessionActions(deps: SessionActionDeps) {
  return {
    navigateTree: createNavigateTree(deps),
    switchClientAwayFromSession: createSwitchClientAway(deps),
    startWorkspace: createStartWorkspace(deps),
    handleSpaceSwitch: createHandleSpaceSwitch(deps),
    handleCloseSelectedWorktree: createHandleCloseSelectedWorktree(deps),
    executeClose: createExecuteClose(deps),
    handleDownSelectedWorktree: createHandleDownSelectedWorktree(deps),
    executeDown: createExecuteDown(deps),
  };
}

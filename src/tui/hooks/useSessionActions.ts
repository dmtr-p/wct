// src/tui/hooks/useSessionActions.ts

import { basename } from "node:path";
import { Effect } from "effect";
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
  type LifecycleClaims,
  type LifecycleState,
  rejectIfLifecycleActive as refuseWhenLifecycleActive,
  runLifecycleOperation,
} from "../lifecycle";
import { tuiRuntime } from "../runtime";
import {
  resolveSessionsHandoff,
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
  // Shared across every lifecycle-driving hook, so a second operation for
  // the same identity is impossible, not just unlikely.
  lifecycleClaims: LifecycleClaims;

  setSelectedIndex: Dispatch<SetStateAction<number>>;
  setMode: (m: Mode) => void;
  // The live mode, readable from async continuations: `mode` above is a
  // render-time capture, stale by the time a lifecycle settles.
  modeRef: MutableRefObject<Mode>;
  setLifecycle: Dispatch<SetStateAction<LifecycleState>>;

  showActionError: (msg: string) => void;
  clearActionError: () => void;

  switchSession: (name: string, client?: TmuxClient | null) => Promise<boolean>;
  detachClient: (client?: TmuxClient | null) => Promise<boolean>;
  discoverClient: (signal?: AbortSignal) => Promise<TmuxClientDiscovery>;
  refreshSessions: (signal?: AbortSignal) => Promise<TmuxSessionInfo[]>;

  // Resolves the registry snapshot the refresh observed, or `null` when it
  // failed (previous repos kept).
  refreshAll: () => Promise<RepoInfo[] | null>;
  restoreConfirmationViewport: () => void;

  confirmDownReturnModeRef: MutableRefObject<Mode>;
  confirmDownReturnSelectedIndexRef: MutableRefObject<number>;
  confirmCloseReturnModeRef: MutableRefObject<Mode>;
  confirmCloseReturnSelectedIndexRef: MutableRefObject<number>;
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
  const switchAwayFromSessions = createSwitchClientAwayFromSessions(deps);
  return (sessionName: string) => switchAwayFromSessions([sessionName]);
}

export function createSwitchClientAwayFromSessions(deps: SessionActionDeps) {
  return (sessionNames: readonly string[]) =>
    tuiRuntime.runPromise(
      Effect.gen(function* () {
        const [client, latestSessions] = yield* Effect.all(
          [
            Effect.tryPromise({
              try: () => deps.discoverClient(),
              catch: toWctError,
            }),
            Effect.tryPromise({
              try: () => deps.refreshSessions(),
              catch: toWctError,
            }),
          ],
          { concurrency: "unbounded" },
        );
        const handoff = resolveSessionsHandoff({
          client,
          targetSessions: sessionNames,
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
            ? yield* Effect.tryPromise({
                try: () => deps.detachClient(client.client),
                catch: toWctError,
              })
            : false;
        }

        return client.type === "single"
          ? yield* Effect.tryPromise({
              try: () =>
                deps.switchSession(handoff.sessionName, client.client),
              catch: toWctError,
            })
          : false;
      }).pipe(Effect.catch(() => Effect.succeed(false))),
    );
}

export interface StartWorkspaceTarget {
  worktreePath: string;
  /** Main repository path — one half of the Workspace Identity. */
  repoPath: string;
  project: string;
  branch: string;
  profile?: string;
  autoSwitch: boolean;
}

// Runs last, after validation and after the lifecycle presentation is gone:
// switching tmux clients detaches the terminal this TUI is drawn in, so a
// failed switch must surface as a plain action error, not a resurrected
// progress row.
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
    if (liveClient.type === "single") {
      const switched = await deps.switchSession(
        result.sessionName,
        liveClient.client,
      );
      await deps.refreshSessions();
      return switched
        ? undefined
        : `Started session '${result.sessionName}', but failed to switch client`;
    }
    if (liveClient.type === "none") {
      return "No tmux client found — start tmux in the other pane";
    }
    if (liveClient.type === "error") {
      return `Started session '${result.sessionName}' but failed to query tmux clients to switch`;
    }
    return "Cannot switch tmux client after start because multiple tmux clients are attached";
  };
}

// Shared by the space-bar start and the up modal.
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
    const returnSelectedIndex =
      resolveSelectedWorktreeIndex(
        deps.treeItems,
        deps.confirmDownReturnSelectedIndexRef.current,
      ) ?? deps.confirmDownReturnSelectedIndexRef.current;

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
      run: async (reporter) => {
        const canProceed = await switchClientAway(sessionName);
        if (!canProceed) {
          throw new Error(
            "Cannot safely stop the tmux session because the active client could not be moved away",
          );
        }

        deps.restoreConfirmationViewport();
        deps.setSelectedIndex(returnSelectedIndex);
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

// Every outcome — removed, refused by git, or fatally failed — goes through
// the same validation step before the Workspace leaves the tree or unlocks,
// so a closed Workspace never disappears optimistically.
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
    const restoredMode = deps.confirmCloseReturnModeRef.current;
    const returnSelectedIndex =
      resolveSelectedWorktreeIndex(
        deps.treeItems,
        deps.confirmCloseReturnSelectedIndexRef.current,
      ) ?? deps.confirmCloseReturnSelectedIndexRef.current;

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
      run: async (reporter) => {
        const canProceed = await switchClientAway(sessionName);
        if (!canProceed) {
          throw new Error(
            "Cannot safely close the worktree because the active tmux client could not be moved away",
          );
        }

        deps.restoreConfirmationViewport();
        deps.setSelectedIndex(returnSelectedIndex);
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
      // Asked from `afterCleanup`, after the lifecycle presentation is fully
      // over, so the confirmation is anchored on a stable tree and a forced
      // retry starts a fresh lifecycle instead of inheriting a stale lock.
      afterCleanup: async (result) => {
        if (result.status !== "blocked_by_changes") return undefined;
        // The user may navigate away while validation runs. Only prompt if
        // the tree is still in the mode this close restored; otherwise just
        // report, so the refusal is never silent but also never clobbers
        // what the user is doing elsewhere.
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
      Mode.ConfirmDown({
        sessionName,
        branch: wt.branch,
        worktreePath: wt.path,
        worktreeKey,
        repoPath: repo.repoPath,
        project: repo.project,
      }),
    );
  };
}

export function useSessionActions(deps: SessionActionDeps) {
  return {
    navigateTree: createNavigateTree(deps),
    switchClientAwayFromSession: createSwitchClientAway(deps),
    switchClientAwayFromSessions: createSwitchClientAwayFromSessions(deps),
    startWorkspace: createStartWorkspace(deps),
    handleSpaceSwitch: createHandleSpaceSwitch(deps),
    handleCloseSelectedWorktree: createHandleCloseSelectedWorktree(deps),
    executeClose: createExecuteClose(deps),
    handleDownSelectedWorktree: createHandleDownSelectedWorktree(deps),
    executeDown: createExecuteDown(deps),
  };
}

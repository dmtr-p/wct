// src/tui/hooks/useSessionActions.ts

import { basename } from "node:path";
import { Effect } from "effect";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { StartWorktreeSessionResult } from "../../commands/worktree-session";
import { startWorktreeSession } from "../../commands/worktree-session";
import { toWctError } from "../../errors";
import { formatSessionName, TmuxService } from "../../services/tmux";
import type { TmuxClient } from "../../services/tmux";
import { WorktreeService } from "../../services/worktree-service";
import { tuiRuntime } from "../runtime";
import {
  resolveSessionHandoff,
  resolveStartActionMessage,
} from "../session-utils";
import { resolveSelectedWorktreeIndex } from "../tree-helpers";
import { Mode, type PendingAction, type TreeItem, pendingKey } from "../types";
import type { RepoInfo } from "./useRegistry";
import type { TmuxClientDiscovery, TmuxSessionInfo } from "./useTmux";

export interface SessionActionDeps {
  treeItems: TreeItem[];
  filteredRepos: RepoInfo[];
  sessions: TmuxSessionInfo[];
  selectedIndex: number;
  mode: Mode;

  setSelectedIndex: Dispatch<SetStateAction<number>>;
  setMode: (m: Mode) => void;
  setPendingActions: Dispatch<SetStateAction<Map<string, PendingAction>>>;

  showActionError: (msg: string) => void;
  clearActionError: () => void;

  switchSession: (name: string, client?: TmuxClient | null) => Promise<boolean>;
  detachClient: (client?: TmuxClient | null) => Promise<boolean>;
  discoverClient: (signal?: AbortSignal) => Promise<TmuxClientDiscovery>;
  refreshSessions: (signal?: AbortSignal) => Promise<TmuxSessionInfo[]>;

  refreshAll: () => Promise<void>;

  confirmDownReturnModeRef: MutableRefObject<Mode>;
  confirmDownReturnSelectedIndexRef: MutableRefObject<number>;
  confirmCloseReturnModeRef: MutableRefObject<Mode>;
  confirmCloseReturnSelectedIndexRef: MutableRefObject<number>;
}

export function createNavigateTree(deps: SessionActionDeps) {
  return (direction: 1 | -1) => {
    deps.setSelectedIndex((prev) => {
      let next = prev + direction;
      while (next >= 0 && next < deps.treeItems.length) {
        const item = deps.treeItems[next];
        if (item?.type === "detail" && item.detailKind === "pane-header") {
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
        ? deps.detachClient(client.client)
        : false;
    }

    return client.type === "single"
      ? deps.switchSession(handoff.sessionName, client.client)
      : false;
  };
}

export function createHandleStartResult(deps: SessionActionDeps) {
  return async (result: StartWorktreeSessionResult, autoSwitch: boolean) => {
    const actionMessage = resolveStartActionMessage(result);

    if (result.tmux.attempted && result.tmux.ok && autoSwitch) {
      const liveClient = await deps.discoverClient();
      if (liveClient.type === "single") {
        const switched = await deps.switchSession(
          result.sessionName,
          liveClient.client,
        );
        await deps.refreshSessions();

        if (!switched) {
          deps.showActionError(
            `Started session '${result.sessionName}', but failed to switch client`,
          );
        } else if (actionMessage) {
          deps.showActionError(actionMessage);
        }
        return;
      }
    }

    await deps.refreshAll();

    if (actionMessage) {
      deps.showActionError(actionMessage);
    }
  };
}

export function createHandleSpaceSwitch(deps: SessionActionDeps) {
  const handleStartResult = createHandleStartResult(deps);

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
    if (!resolvedItem || resolvedItem.type !== "worktree") return;
    const repo = deps.filteredRepos[resolvedItem.repoIndex];
    if (!repo) return;
    const wt = repo.worktrees[resolvedItem.worktreeIndex];
    if (!wt) return;
    const sessionName = formatSessionName(basename(wt.path));
    const hasSession = deps.sessions.some((s) => s.name === sessionName);
    if (hasSession) {
      deps.clearActionError();
      void deps.switchSession(sessionName).then((switched) => {
        if (!switched) {
          deps.showActionError(
            `Failed to switch to tmux session '${sessionName}'`,
          );
        }
      });
    } else {
      const pendingActionKey = pendingKey(repo.project, wt.branch);
      deps.clearActionError();
      deps.setPendingActions((prev) =>
        new Map(prev).set(pendingActionKey, {
          type: "starting",
          branch: wt.branch,
          project: repo.project,
        }),
      );
      void (async () => {
        try {
          const startResult = await tuiRuntime.runPromise(
            startWorktreeSession({ path: wt.path }),
          );
          await handleStartResult(startResult, true);
        } catch (error) {
          deps.showActionError(toWctError(error).message);
          await deps.refreshAll();
        } finally {
          deps.setPendingActions((prev) => {
            const next = new Map(prev);
            next.delete(pendingActionKey);
            return next;
          });
        }
      })();
    }
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
    if (!item || item.type !== "worktree") return;

    const repo = deps.filteredRepos[item.repoIndex];
    const wt = repo?.worktrees[item.worktreeIndex];
    if (!repo || !wt) return;

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

    deps.setSelectedIndex(deps.confirmCloseReturnSelectedIndexRef.current);
    deps.setMode(deps.confirmCloseReturnModeRef.current);

    deps.setPendingActions((prev) =>
      new Map(prev).set(worktreeKey, {
        type: "closing",
        branch,
        project,
      }),
    );

    try {
      await tuiRuntime.runPromise(
        Effect.gen(function* () {
          const exists = yield* TmuxService.use((service) =>
            service.sessionExists(sessionName),
          );
          if (exists) {
            yield* TmuxService.use((service) =>
              service.killSession(sessionName),
            );
          }
        }),
      );

      const removeResult = await tuiRuntime.runPromise(
        WorktreeService.use((service) =>
          service.removeWorktree(worktreePath, force, repoPath),
        ),
      );

      if (removeResult._tag === "BlockedByChanges") {
        deps.setPendingActions((prev) => {
          const next = new Map(prev);
          next.delete(worktreeKey);
          return next;
        });
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
        await deps.refreshAll();
        return;
      }

      await deps.refreshAll();
    } catch (error) {
      deps.showActionError(toWctError(error).message);
      await deps.refreshAll();
    } finally {
      deps.setPendingActions((prev) => {
        const next = new Map(prev);
        next.delete(worktreeKey);
        return next;
      });
    }
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
    if (!item || item.type !== "worktree") return;

    const repo = deps.filteredRepos[item.repoIndex];
    const wt = repo?.worktrees[item.worktreeIndex];
    if (!repo || !wt) return;

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
      Mode.ConfirmDown(sessionName, wt.branch, wt.path, worktreeKey),
    );
  };
}

export function useSessionActions(deps: SessionActionDeps) {
  return {
    navigateTree: createNavigateTree(deps),
    switchClientAwayFromSession: createSwitchClientAway(deps),
    handleStartResult: createHandleStartResult(deps),
    handleSpaceSwitch: createHandleSpaceSwitch(deps),
    handleCloseSelectedWorktree: createHandleCloseSelectedWorktree(deps),
    executeClose: createExecuteClose(deps),
    handleDownSelectedWorktree: createHandleDownSelectedWorktree(deps),
  };
}

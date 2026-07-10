import type { Key } from "ink";
import type { TmuxSessionInfo } from "../hooks/useTmux";
import {
  findOwningWorktreeIndex,
  resolveExpandedRightArrowAction,
  resolveSelectedPane,
} from "../tree-helpers";
import { Mode, type PaneInfo, pendingKey } from "../types";
import type { NavigateContext } from "./navigate";

export interface ExpandedContext extends NavigateContext {
  panes: Map<string, PaneInfo[]>;
  setSelectedIndex: (i: number) => void;
  zoomPane: (paneId: string) => Promise<boolean>;
  killPane: (paneId: string) => Promise<boolean>;
  refreshSessions: (signal?: AbortSignal) => Promise<TmuxSessionInfo[]>;
  collapseWorktree: (worktreeKey: string) => void;
}

export function handleExpandedInput(
  ctx: ExpandedContext,
  input: string,
  key: Key,
): void {
  if (key.leftArrow) {
    const worktreeIndex = findOwningWorktreeIndex(
      ctx.treeItems,
      ctx.selectedIndex,
    );
    if (worktreeIndex === null) return;
    const item = ctx.treeItems[worktreeIndex];
    if (item?.type !== "worktree") return;
    const repo = ctx.filteredRepos[item.repoIndex];
    const worktree = repo?.worktrees[item.worktreeIndex];
    if (!repo || !worktree) return;

    ctx.setSelectedIndex(worktreeIndex);
    ctx.collapseWorktree(pendingKey(repo.project, worktree.branch));
    return;
  }

  if (key.upArrow) {
    ctx.navigateTree(-1);
    return;
  }

  if (key.downArrow) {
    ctx.navigateTree(1);
    return;
  }

  if (key.rightArrow) {
    const action = resolveExpandedRightArrowAction({
      repos: ctx.filteredRepos,
      items: ctx.treeItems,
      selectedIndex: ctx.selectedIndex,
    });

    if (action.type === "expand-worktree") {
      ctx.setSelectedIndex(action.nextSelectedIndex);
      ctx.expandWorktree(action.worktreeKey);
    }

    return;
  }

  if (input === " " && ctx.tmuxClient) {
    ctx.handleSpaceSwitch();
    return;
  }

  if (input === "o") {
    ctx.prepareOpenModal();
    return;
  }

  if (input === "d" && ctx.tmuxClient) {
    ctx.handleDownSelectedWorktree();
    return;
  }

  if (input === "u") {
    ctx.prepareUpModal();
    return;
  }

  if (input === "a") {
    ctx.prepareAddProjectModal();
    return;
  }

  if (input === "c") {
    ctx.handleCloseSelectedWorktree();
    return;
  }

  if (input === "/") {
    ctx.setMode(Mode.Search);
    ctx.setSearchQuery("");
    return;
  }

  if (input === "z" && ctx.tmuxClient) {
    const selectedPane = resolveSelectedPane({
      repos: ctx.filteredRepos,
      items: ctx.treeItems,
      panes: ctx.panes,
      selectedIndex: ctx.selectedIndex,
    });
    if (!selectedPane) {
      return;
    }
    void ctx
      .zoomPane(selectedPane.pane.paneId)
      .then(() => ctx.refreshSessions());
    return;
  }

  if (input === "x" && ctx.tmuxClient) {
    const selectedPane = resolveSelectedPane({
      repos: ctx.filteredRepos,
      items: ctx.treeItems,
      panes: ctx.panes,
      selectedIndex: ctx.selectedIndex,
    });
    if (!selectedPane) {
      return;
    }
    ctx.setMode(
      Mode.ConfirmKill(
        selectedPane.pane.paneId,
        selectedPane.label,
        selectedPane.worktreeKey,
      ),
    );
  }
}

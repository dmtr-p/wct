import type { Key } from "ink";
import type { TmuxSessionInfo } from "../hooks/useTmux";
import {
  adjustIndexForDetailCollapse,
  resolveExpandedRightArrowAction,
  resolveSelectedPane,
} from "../tree-helpers";
import { Mode, type PaneInfo } from "../types";
import type { NavigateContext } from "./navigate";

export interface ExpandedContext extends NavigateContext {
  panes: Map<string, PaneInfo[]>;
  setSelectedIndex: (i: number) => void;
  zoomPane: (paneId: string) => Promise<boolean>;
  killPane: (paneId: string) => Promise<boolean>;
  refreshSessions: (signal?: AbortSignal) => Promise<TmuxSessionInfo[]>;
}

export function handleExpandedInput(
  ctx: ExpandedContext,
  input: string,
  key: Key,
): void {
  if (key.leftArrow || key.escape) {
    ctx.setSelectedIndex(
      adjustIndexForDetailCollapse(ctx.treeItems, ctx.selectedIndex),
    );
    ctx.setMode(Mode.Navigate);
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
      expandedRepos: ctx.expandedRepos,
    });

    if (action.type === "expand-repo") {
      ctx.toggleExpanded(action.repoId);
      return;
    }

    if (action.type === "expand-worktree") {
      ctx.setSelectedIndex(action.nextSelectedIndex);
      ctx.setMode(action.nextMode);
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

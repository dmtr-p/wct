import type { Key } from "ink";
import {
  isLifecycleActive,
  type LifecycleState,
  workspaceIdentityKey,
} from "../lifecycle";
import {
  type CommonNavigationContext,
  handleCommonNavigationInput,
} from "./common-navigation";

export interface NavigateContext extends CommonNavigationContext {
  lifecycle: LifecycleState;
  expandWorktree: (workspaceKey: string) => void;
  navigateTree: (dir: 1 | -1) => void;
  handleCloseSelectedWorktree: () => void;
}

export function handleNavigateInput(
  ctx: NavigateContext,
  input: string,
  key: Key,
): void {
  if (handleCommonNavigationInput(ctx, input, key)) return;

  if (key.upArrow) {
    ctx.navigateTree(-1);
    return;
  }

  if (key.downArrow) {
    ctx.navigateTree(1);
    return;
  }

  const currentItem = ctx.treeItems[ctx.selectedIndex];
  if (!currentItem) return;

  const currentRepo = ctx.filteredRepos[currentItem.repoIndex];
  if (!currentRepo) return;

  const currentWorktree =
    currentItem.type === "worktree" && currentItem.worktreeIndex !== undefined
      ? currentRepo.worktrees[currentItem.worktreeIndex]
      : undefined;

  if (key.rightArrow) {
    if (currentItem.type === "worktree" && currentWorktree) {
      if (
        isLifecycleActive(
          ctx.lifecycle,
          currentRepo.repoPath,
          currentWorktree.branch,
        )
      ) {
        return;
      }
      ctx.expandWorktree(
        workspaceIdentityKey(currentRepo.repoPath, currentWorktree.branch),
      );
      return;
    }
  }

  if (input === "c" && currentItem.type === "worktree" && currentWorktree) {
    ctx.handleCloseSelectedWorktree();
    return;
  }
}

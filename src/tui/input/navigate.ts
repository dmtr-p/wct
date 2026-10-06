import type { Key } from "ink";
import type { TmuxClient } from "../../services/tmux";
import type { RepoInfo } from "../hooks/useRegistry";
import { isLifecycleActive, type LifecycleState } from "../lifecycle";
import { Mode, type TreeItem, worktreeDisplayKey } from "../types";

export interface NavigateContext {
  treeItems: TreeItem[];
  filteredRepos: RepoInfo[];
  selectedIndex: number;
  tmuxClient: TmuxClient | null;
  lifecycle: LifecycleState;

  setMode: (m: Mode) => void;
  setSearchQuery: (q: string) => void;
  expandWorktree: (worktreeKey: string) => void;

  navigateTree: (dir: 1 | -1) => void;
  prepareOpenModal: () => void;
  prepareUpModal: () => void;
  handleSpaceSwitch: () => void;
  handleDownSelectedWorktree: () => void;
  handleCloseSelectedWorktree: () => void;
  prepareRemoveProject: () => void;
  prepareAddProjectModal: () => void;
  refreshRepo: (repoPath: string) => void;
}

export function handleNavigateInput(
  ctx: NavigateContext,
  input: string,
  key: Key,
): void {
  if (input === "/") {
    ctx.setMode(Mode.Search);
    ctx.setSearchQuery("");
    return;
  }

  if (input === "o") {
    ctx.prepareOpenModal();
    return;
  }

  if (input === " " && ctx.tmuxClient) {
    ctx.handleSpaceSwitch();
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

  if (key.delete || key.backspace) {
    ctx.prepareRemoveProject();
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

  const currentItem = ctx.treeItems[ctx.selectedIndex];
  if (!currentItem) return;

  const currentRepo = ctx.filteredRepos[currentItem.repoIndex];
  if (!currentRepo) return;

  if (input === "r") {
    ctx.refreshRepo(currentRepo.repoPath);
    return;
  }

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
        worktreeDisplayKey(currentRepo.project, currentWorktree.branch),
      );
      return;
    }
  }

  if (input === "c" && currentItem.type === "worktree" && currentWorktree) {
    ctx.handleCloseSelectedWorktree();
    return;
  }
}

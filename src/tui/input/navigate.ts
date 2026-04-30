import type { Key } from "ink";
import type { TmuxClient } from "../../services/tmux";
import type { RepoInfo } from "../hooks/useRegistry";
import { Mode, pendingKey, type TreeItem } from "../types";

export interface NavigateContext {
  treeItems: TreeItem[];
  filteredRepos: RepoInfo[];
  selectedIndex: number;
  expandedRepos: Set<string>;
  tmuxClient: TmuxClient | null;

  setMode: (m: Mode) => void;
  setSearchQuery: (q: string) => void;

  navigateTree: (dir: 1 | -1) => void;
  toggleExpanded: (repoId: string) => void;
  prepareOpenModal: () => void;
  prepareUpModal: () => void;
  handleSpaceSwitch: () => void;
  handleDownSelectedWorktree: () => void;
  handleCloseSelectedWorktree: () => void;
  prepareAddProjectModal: () => void;
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

  if (key.leftArrow && currentItem.type === "repo") {
    if (ctx.expandedRepos.has(currentRepo.id)) {
      ctx.toggleExpanded(currentRepo.id);
    }
    return;
  }

  if (key.rightArrow) {
    if (currentItem.type === "repo") {
      if (!ctx.expandedRepos.has(currentRepo.id)) {
        ctx.toggleExpanded(currentRepo.id);
      }
      return;
    }
    if (currentItem.type === "worktree" && currentWorktree) {
      ctx.setMode(
        Mode.Expanded(pendingKey(currentRepo.project, currentWorktree.branch)),
      );
      return;
    }
  }

  if (input === "c" && currentItem.type === "worktree" && currentWorktree) {
    ctx.handleCloseSelectedWorktree();
    return;
  }
}

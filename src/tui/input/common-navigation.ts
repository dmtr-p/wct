import type { Key } from "ink";
import type { TmuxClient } from "../../services/tmux";
import type { RepoInfo } from "../hooks/useRegistry";
import { Mode, type TreeItem } from "../types";

export interface CommonNavigationContext {
  treeItems: TreeItem[];
  filteredRepos: RepoInfo[];
  selectedIndex: number;
  tmuxClient: TmuxClient | null;
  setMode: (m: Mode) => void;
  setSearchQuery: (q: string) => void;
  prepareOpenModal: () => void;
  prepareUpModal: () => void;
  handleSpaceSwitch: () => void;
  handleDownSelectedWorktree: () => void;
  prepareRemoveProject: () => void;
  prepareAddProjectModal: () => void;
  refreshRepo: (repoPath: string) => void;
}

export function handleCommonNavigationInput(
  ctx: CommonNavigationContext,
  input: string,
  key: Key,
): boolean {
  if (input === "/") {
    ctx.setMode(Mode.Search);
    ctx.setSearchQuery("");
    return true;
  }

  if (input === "o") {
    ctx.prepareOpenModal();
    return true;
  }

  if (input === " " && ctx.tmuxClient) {
    ctx.handleSpaceSwitch();
    return true;
  }

  if (input === "d") {
    ctx.handleDownSelectedWorktree();
    return true;
  }

  if (input === "u") {
    ctx.prepareUpModal();
    return true;
  }

  if (input === "a") {
    ctx.prepareAddProjectModal();
    return true;
  }

  if (key.delete || key.backspace) {
    ctx.prepareRemoveProject();
    return true;
  }

  if (input === "r") {
    const item = ctx.treeItems[ctx.selectedIndex];
    const repo = item && ctx.filteredRepos[item.repoIndex];
    if (repo) ctx.refreshRepo(repo.repoPath);
    return true;
  }

  return false;
}

// src/tui/tree-helpers.ts

import { basename } from "node:path";
import { formatSessionName } from "../services/tmux";
import type { RepoInfo } from "./hooks/useRegistry";
import {
  Mode,
  type PaneInfo,
  type PRInfo,
  pendingKey,
  type TreeItem,
} from "./types";

interface BuildTreeOptions {
  repos: RepoInfo[];
  expandedRepos: Set<string>;
  expandedWorktreeKey: string | null;
  prData: Map<string, PRInfo>;
  panes: Map<string, PaneInfo[]>;
  jumpToPane: (paneId: string) => void;
}

interface ResolveSelectedPaneOptions {
  repos: RepoInfo[];
  items: TreeItem[];
  panes: Map<string, PaneInfo[]>;
  selectedIndex: number;
}

interface SelectedPaneResolution {
  pane: PaneInfo;
  label: string;
  worktreeKey: string;
}

interface ResolveStatusBarPropsOptions {
  mode: Mode;
  items: TreeItem[];
  selectedIndex: number;
  repos?: RepoInfo[];
}

interface ResolveExpandedRightArrowActionOptions {
  repos: RepoInfo[];
  items: TreeItem[];
  selectedIndex: number;
  expandedRepos: Set<string>;
}

interface ResolveRecoveredSelectionIndexOptions {
  prevTree: TreeItem[];
  treeItems: TreeItem[];
  prevSelectionId: string | null;
  selectedIndex: number;
  repos: RepoInfo[];
  skipIdentityRecovery?: boolean;
}

interface ResolveCloseSelectedWorktreeActionOptions {
  mode: Mode;
  repos: RepoInfo[];
  items: TreeItem[];
  selectedIndex: number;
}

type ExpandedRightArrowAction =
  | { type: "noop" }
  | { type: "expand-repo"; repoId: string }
  | { type: "expand-worktree"; nextMode: Mode; nextSelectedIndex: number };

type CloseSelectedWorktreeAction =
  | { type: "noop" }
  | {
      type: "close-worktree";
      worktreeIndex: number;
      worktreeKey: string;
      nextMode?: Mode;
      nextSelectedIndex?: number;
    };

export interface ResolvedStatusBarProps {
  mode: Mode;
  selectedPaneRow?: boolean;
  /** The project identifier of the repo that the cursor is on or under. */
  selectedProject?: string;
}

export function buildTreeItems({
  repos,
  expandedRepos,
  expandedWorktreeKey,
  prData,
  panes,
  jumpToPane,
}: BuildTreeOptions): TreeItem[] {
  const items: TreeItem[] = [];
  for (let ri = 0; ri < repos.length; ri++) {
    const repo = repos[ri];
    if (!repo) {
      continue;
    }

    items.push({ type: "repo", repoIndex: ri });
    if (expandedRepos.has(repo.id)) {
      for (let wi = 0; wi < repo.worktrees.length; wi++) {
        items.push({ type: "worktree", repoIndex: ri, worktreeIndex: wi });

        const wt = repo.worktrees[wi];
        if (!wt) continue;
        const wtKey = pendingKey(repo.project, wt.branch);
        if (wtKey !== expandedWorktreeKey) continue;

        const sessionName = formatSessionName(basename(wt.path));

        // PR data for this worktree
        const pr = prData.get(wtKey);
        if (pr) {
          items.push({
            type: "detail",
            repoIndex: ri,
            worktreeIndex: wi,
            detailKind: "pr",
            label: `PR #${pr.number}: ${pr.title} (${pr.state})`,
            meta: { rollupState: pr.rollupState },
            action: () =>
              Bun.spawn(["gh", "pr", "view", "--web", String(pr.number)], {
                cwd: repo.repoPath,
              }),
          });
        }

        // Panes for this worktree
        const sessionPanes = panes.get(sessionName);
        if (sessionPanes && sessionPanes.length > 0) {
          items.push({
            type: "detail",
            repoIndex: ri,
            worktreeIndex: wi,
            detailKind: "pane-header",
            label: `Panes (${sessionPanes.length})`,
          });
          for (const pane of sessionPanes) {
            items.push({
              type: "detail",
              repoIndex: ri,
              worktreeIndex: wi,
              detailKind: "pane",
              label: `${pane.window}:${pane.paneIndex} ${pane.command}`,
              meta: {
                paneId: pane.paneId,
                zoomed: pane.zoomed,
                active: pane.active,
                window: pane.window,
                paneIndex: pane.paneIndex,
                command: pane.command,
              },
              action: () => jumpToPane(pane.paneId),
            });
          }
        }
      }
    }
  }
  return items;
}

/**
 * Compute a stable identity string for a tree item using repo id and branch,
 * so selection can be recovered after background refreshes that shift indices.
 */
export function treeItemId(item: TreeItem, repos: RepoInfo[]): string | null {
  const repo = repos[item.repoIndex];
  if (!repo) return null;
  if (item.type === "repo") return `repo:${repo.id}`;
  const wt = repo.worktrees[item.worktreeIndex];
  if (!wt) return null;
  if (item.type === "worktree") return `wt:${repo.id}/${wt.branch}`;
  const base = `detail:${repo.id}/${wt.branch}/${item.detailKind}`;
  if (item.detailKind === "pane" && item.meta.paneId)
    return `${base}/${item.meta.paneId}`;
  return base;
}

/**
 * Compute the adjusted selectedIndex after all detail rows are removed from the
 * tree (e.g. when exiting Expanded mode or switching expanded worktree).
 *
 * - If the cursor is on a detail row, snap to its parent worktree.
 * - Otherwise subtract the number of detail rows before the cursor.
 */
export function adjustIndexForDetailCollapse(
  items: TreeItem[],
  selectedIndex: number,
): number {
  const current = items[selectedIndex];

  if (current?.type === "detail") {
    return findOwningWorktreeIndex(items, selectedIndex) ?? 0;
  }

  let detailsBefore = 0;
  for (let i = 0; i < selectedIndex; i++) {
    if (items[i]?.type === "detail") detailsBefore++;
  }
  return selectedIndex - detailsBefore;
}

export function resolveRecoveredSelectionIndex({
  prevTree,
  treeItems,
  prevSelectionId,
  selectedIndex,
  repos,
  skipIdentityRecovery = false,
}: ResolveRecoveredSelectionIndexOptions): number | null {
  if (prevTree === treeItems || !prevSelectionId || skipIdentityRecovery) {
    return null;
  }

  const currentItem = treeItems[selectedIndex];
  if (currentItem && treeItemId(currentItem, repos) === prevSelectionId) {
    return null;
  }

  for (let i = 0; i < treeItems.length; i++) {
    const candidate = treeItems[i];
    if (candidate && treeItemId(candidate, repos) === prevSelectionId) {
      return i;
    }
  }

  if (treeItems.length === 0) {
    return 0;
  }

  if (selectedIndex >= treeItems.length) {
    return treeItems.length - 1;
  }

  return null;
}

export function resolveSelectedWorktreeIndex(
  items: TreeItem[],
  selectedIndex: number,
): number | null {
  const selected = items[selectedIndex];
  if (!selected) {
    return null;
  }

  if (selected.type === "worktree") {
    return selectedIndex;
  }

  if (selected.type === "detail") {
    return findOwningWorktreeIndex(items, selectedIndex);
  }

  return null;
}

export function resolveCloseSelectedWorktreeAction({
  mode,
  repos,
  items,
  selectedIndex,
}: ResolveCloseSelectedWorktreeActionOptions): CloseSelectedWorktreeAction {
  const worktreeIndex = resolveSelectedWorktreeIndex(items, selectedIndex);
  if (worktreeIndex === null) {
    return { type: "noop" };
  }

  const selectedWorktree = items[worktreeIndex];
  if (!selectedWorktree || selectedWorktree.type !== "worktree") {
    return { type: "noop" };
  }

  const repo = repos[selectedWorktree.repoIndex];
  const worktree = repo?.worktrees[selectedWorktree.worktreeIndex];
  if (!repo || !worktree) {
    return { type: "noop" };
  }

  const worktreeKey = pendingKey(repo.project, worktree.branch);
  if (
    (mode.type === "Expanded" ||
      mode.type === "ConfirmKill" ||
      mode.type === "ConfirmDown" ||
      mode.type === "ConfirmClose" ||
      mode.type === "ConfirmCloseForce") &&
    mode.worktreeKey === worktreeKey
  ) {
    return {
      type: "close-worktree",
      worktreeIndex,
      worktreeKey,
      nextMode: Mode.Navigate,
      nextSelectedIndex: adjustIndexForDetailCollapse(items, selectedIndex),
    };
  }

  return {
    type: "close-worktree",
    worktreeIndex,
    worktreeKey,
  };
}

export function resolveExpandedRightArrowAction({
  repos,
  items,
  selectedIndex,
  expandedRepos,
}: ResolveExpandedRightArrowActionOptions): ExpandedRightArrowAction {
  const current = items[selectedIndex];
  if (!current) {
    return { type: "noop" };
  }

  const repo = repos[current.repoIndex];
  if (!repo) {
    return { type: "noop" };
  }

  if (current.type === "repo") {
    if (expandedRepos.has(repo.id)) {
      return { type: "noop" };
    }

    return { type: "expand-repo", repoId: repo.id };
  }

  if (current.type !== "worktree") {
    return { type: "noop" };
  }

  const worktree = repo.worktrees[current.worktreeIndex];
  if (!worktree) {
    return { type: "noop" };
  }

  return {
    type: "expand-worktree",
    nextMode: Mode.Expanded(pendingKey(repo.project, worktree.branch)),
    nextSelectedIndex: adjustIndexForDetailCollapse(items, selectedIndex),
  };
}

export function findOwningWorktreeIndex(
  items: TreeItem[],
  selectedIndex: number,
): number | null {
  const selected = items[selectedIndex];
  if (!selected) {
    return null;
  }

  if (selected.type === "worktree") {
    return selectedIndex;
  }

  if (selected.type !== "detail") {
    return null;
  }

  for (let i = selectedIndex - 1; i >= 0; i--) {
    const candidate = items[i];
    if (candidate?.type === "worktree") {
      return i;
    }
  }

  return null;
}

export function resolveSelectedPane({
  repos,
  items,
  panes,
  selectedIndex,
}: ResolveSelectedPaneOptions): SelectedPaneResolution | null {
  const selected = items[selectedIndex];
  if (
    !selected ||
    selected.type !== "detail" ||
    selected.detailKind !== "pane"
  ) {
    return null;
  }

  const repo = repos[selected.repoIndex];
  const worktree = repo?.worktrees[selected.worktreeIndex];
  if (!repo || !worktree) {
    return null;
  }

  const sessionName = formatSessionName(basename(worktree.path));
  const sessionPanes = panes.get(sessionName);
  if (!sessionPanes) {
    return null;
  }

  const paneId = selected.meta.paneId;
  if (!paneId) {
    return null;
  }

  const pane = sessionPanes.find((candidate) => candidate.paneId === paneId);

  if (!pane) {
    return null;
  }

  return {
    pane,
    label: selected.label,
    worktreeKey: pendingKey(repo.project, worktree.branch),
  };
}

export function resolveStatusBarProps({
  mode,
  items,
  selectedIndex,
  repos,
}: ResolveStatusBarPropsOptions): ResolvedStatusBarProps {
  const selectedItem = items[selectedIndex];
  const selectedProject =
    selectedItem && repos ? repos[selectedItem.repoIndex]?.project : undefined;

  return {
    mode,
    selectedPaneRow:
      selectedItem?.type === "detail" && selectedItem.detailKind === "pane",
    selectedProject,
  };
}

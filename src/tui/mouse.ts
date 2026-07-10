import { formatSync } from "../services/worktree-service";
import type { RepoInfo } from "./hooks/useRegistry";
import { type PendingAction, pendingKey, type TreeItem } from "./types";

export interface MouseClick {
  column: number;
  row: number;
}

export interface MouseScroll extends MouseClick {
  direction: -1 | 1;
}

export interface MouseClickHistory {
  targetId: string;
  timestamp: number;
}

export interface MouseClickDetection {
  isDoubleClick: boolean;
  history: MouseClickHistory | null;
}

export type TreeDoubleClickAction =
  | { type: "noop" }
  | { type: "expand-worktree"; worktreeKey: string }
  | { type: "collapse-worktree"; worktreeKey: string }
  | { type: "activate-detail"; action: () => void };

export const DOUBLE_CLICK_INTERVAL_MS = 400;

interface ResolveTreeMouseTargetOptions {
  row: number;
  scrollOffset?: number;
  items: TreeItem[];
  repos: RepoInfo[];
  pendingActions: Map<string, PendingAction>;
  expandedWorktreeKeys: Set<string>;
}

interface TreeRenderedRowsOptions {
  items: TreeItem[];
  repos: RepoInfo[];
  pendingActions: Map<string, PendingAction>;
  expandedWorktreeKeys: Set<string>;
}

interface SgrMousePress extends MouseClick {
  button: number;
}

function parseSgrMousePress(input: string): SgrMousePress | null {
  const sequence = input.startsWith("\u001B") ? input.slice(1) : input;
  const match = /^\[<([0-9]+);([0-9]+);([0-9]+)M$/.exec(sequence);
  if (!match) return null;

  const button = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  if (column < 1 || row < 1) return null;

  return { button, column, row };
}

/** Parse an unmodified SGR left-button press after Ink's escape stripping. */
export function parseMouseClick(input: string): MouseClick | null {
  const press = parseSgrMousePress(input);
  if (press?.button !== 0) return null;

  return { column: press.column, row: press.row };
}

/** Parse unmodified SGR wheel presses into viewport directions. */
export function parseMouseScroll(input: string): MouseScroll | null {
  const press = parseSgrMousePress(input);
  if (!press || (press.button !== 64 && press.button !== 65)) return null;

  return {
    column: press.column,
    direction: press.button === 64 ? -1 : 1,
    row: press.row,
  };
}

/** Detect two presses on the same tree item within the double-click window. */
export function detectDoubleClick(
  previous: MouseClickHistory | null,
  targetId: string,
  timestamp: number,
): MouseClickDetection {
  const elapsed = previous ? timestamp - previous.timestamp : -1;
  const isDoubleClick =
    previous?.targetId === targetId &&
    elapsed >= 0 &&
    elapsed <= DOUBLE_CLICK_INTERVAL_MS;

  return {
    isDoubleClick,
    // Clearing consumed pairs prevents a third rapid click from activating twice.
    history: isDoubleClick ? null : { targetId, timestamp },
  };
}

/** Resolve the limited set of tree rows that support double-click activation. */
export function resolveTreeDoubleClickAction(
  item: TreeItem,
  repos: RepoInfo[],
  expandedWorktreeKeys: Set<string>,
): TreeDoubleClickAction {
  if (item.type === "worktree") {
    const repo = repos[item.repoIndex];
    const worktree = repo?.worktrees[item.worktreeIndex];
    if (!repo || !worktree) return { type: "noop" };

    const worktreeKey = pendingKey(repo.project, worktree.branch);
    return expandedWorktreeKeys.has(worktreeKey)
      ? { type: "collapse-worktree", worktreeKey }
      : { type: "expand-worktree", worktreeKey };
  }

  if (
    item.type === "detail" &&
    (item.detailKind === "pr" || item.detailKind === "pane") &&
    item.action
  ) {
    return { type: "activate-detail", action: item.action };
  }

  return { type: "noop" };
}

/** Map every rendered physical tree row to its owning selectable item. */
export function getTreeRenderedRows({
  items,
  repos,
  pendingActions,
  expandedWorktreeKeys,
}: TreeRenderedRowsOptions): Array<number | null> {
  const existingKeys = new Set<string>();
  for (const repo of repos) {
    for (const worktree of repo.worktrees) {
      existingKeys.add(pendingKey(repo.project, worktree.branch));
    }
  }

  const phantomCountByProject = new Map<string, number>();
  for (const [key, action] of pendingActions) {
    if (action.type !== "opening" || existingKeys.has(key)) continue;
    phantomCountByProject.set(
      action.project,
      (phantomCountByProject.get(action.project) ?? 0) + 1,
    );
  }

  const rows: Array<number | null> = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item) continue;
    rows.push(index);

    const repo = repos[item.repoIndex];
    if (!repo) continue;

    const worktree =
      item.type === "worktree" ? repo.worktrees[item.worktreeIndex] : undefined;
    const formattedSync = worktree ? formatSync(worktree.sync) : "";
    const hasSyncStats = formattedSync !== "" && formattedSync !== "\u2713";
    const worktreeKey = worktree
      ? pendingKey(repo.project, worktree.branch)
      : null;
    const pendingStatus = worktreeKey
      ? pendingActions.get(worktreeKey)?.type
      : undefined;
    const hasSecondaryRow =
      (item.type === "repo" && repo.worktrees.length === 0) ||
      (!!worktree &&
        worktreeKey !== null &&
        expandedWorktreeKeys.has(worktreeKey) &&
        pendingStatus !== "opening" &&
        pendingStatus !== "closing" &&
        pendingStatus !== "stopping" &&
        (hasSyncStats || worktree.changedFiles > 0));

    if (hasSecondaryRow) {
      rows.push(index);
    }

    if (item.type !== "worktree") continue;
    const nextItem = items[index + 1];
    const isLastWorktreeForRepo =
      !nextItem ||
      nextItem.type === "repo" ||
      nextItem.repoIndex !== item.repoIndex;
    if (!isLastWorktreeForRepo) continue;

    const phantomCount = phantomCountByProject.get(repo.project) ?? 0;
    for (let phantomIndex = 0; phantomIndex < phantomCount; phantomIndex++) {
      rows.push(null);
    }
  }

  // TreeView appends phantoms belonging to empty repos after its main item loop.
  for (const repo of repos) {
    if (repo.worktrees.length > 0) continue;
    const phantomCount = phantomCountByProject.get(repo.project) ?? 0;
    for (let phantomIndex = 0; phantomIndex < phantomCount; phantomIndex++) {
      rows.push(null);
    }
  }

  return rows;
}

/** Resolve a visible tree row to its selectable item, accounting for scrolling. */
export function resolveTreeMouseTarget({
  row,
  scrollOffset = 0,
  ...options
}: ResolveTreeMouseTargetOptions): number | null {
  if (row < 0) return null;
  return getTreeRenderedRows(options)[row + scrollOffset] ?? null;
}

export function scrollTreeViewport(
  currentOffset: number,
  delta: number,
  totalRows: number,
  viewportHeight: number,
): number {
  const maxOffset = Math.max(0, totalRows - Math.max(1, viewportHeight));
  return Math.max(0, Math.min(maxOffset, currentOffset + delta));
}

export function resolveTreeViewportHeight(
  terminalRows: number,
  footerHeight: number,
  modalVisible: boolean,
): number {
  if (modalVisible) return 0;
  return Math.max(0, terminalRows - 2 - footerHeight);
}

/** Adjust the viewport just enough to show every row owned by an item. */
export function revealTreeItem(
  rows: Array<number | null>,
  itemIndex: number,
  currentOffset: number,
  viewportHeight: number,
): number {
  const firstRow = rows.indexOf(itemIndex);
  if (firstRow === -1) {
    return scrollTreeViewport(currentOffset, 0, rows.length, viewportHeight);
  }

  const lastRow = rows.lastIndexOf(itemIndex);
  const visibleHeight = Math.max(1, viewportHeight);
  const itemHeight = lastRow - firstRow + 1;
  let nextOffset = currentOffset;
  if (itemHeight > visibleHeight) {
    nextOffset = firstRow;
  } else if (firstRow < currentOffset) {
    nextOffset = firstRow;
  } else if (lastRow >= currentOffset + viewportHeight) {
    nextOffset = lastRow - visibleHeight + 1;
  }

  return scrollTreeViewport(nextOffset, 0, rows.length, viewportHeight);
}

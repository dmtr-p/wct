import type { RepoInfo } from "./hooks/useRegistry";
import type { LifecycleState } from "./lifecycle";
import {
  clampScrollOffset,
  confirmationRowRange,
  firstRowForItem,
  isInertTreeItem,
  resolveLifecycleReveal,
  resolveRecoveredSelectionIndex,
  resolveSelectedWorktreeIndex,
  scrollRangeToKeepVisible,
  scrollToKeepVisible,
  type TreeRow,
  treeItemId,
  treeItemParentId,
} from "./tree-helpers";
import type { TreeItem } from "./types";

export interface TreeNavigationSnapshot {
  items: TreeItem[];
  repos: RepoInfo[];
  rows: TreeRow[];
  viewportRows: number;
  /** The committed viewport height after selecting this item changes the footer. */
  viewportRowsForSelection?: (itemIndex: number) => number;
  searchQuery: string;
  lifecycle: LifecycleState;
  confirming: boolean;
  confirmationPosition?: ReturnPosition | null;
}

export type ReturnPosition =
  | "down"
  | "close"
  | "delete-project"
  | "kill"
  | "up";

interface SavedPosition {
  selectedIndex: number;
  scrollOffset: number;
  owningWorktreeIndex: number | null;
  selectedId: string | null;
  owningWorktreeId: string | null;
}

export interface TreeNavigationState {
  selectedIndex: number;
  scrollOffset: number;
  previousItems: TreeItem[] | null;
  previousSelectionId: string | null;
  previousSelectionParentId: string | null;
  previousRow: number | null;
  previousViewportRows: number;
  previousSelectionVisible: boolean;
  searchQuery: string;
  confirmationRange: { start: number; end: number } | null;
  confirmationPosition: ReturnPosition | null;
  savedPositions: Partial<Record<ReturnPosition, SavedPosition>>;
  revealedLifecycles: ReadonlySet<string>;
  selectionPending: boolean;
  restorePending: boolean;
}

export type TreeNavigationIntent =
  | { type: "reconcile" }
  | { type: "move"; direction: 1 | -1 }
  | { type: "select"; itemIndex: number }
  | { type: "wheel"; delta: number }
  | { type: "capture"; position: ReturnPosition; preserveSelection?: boolean }
  | {
      type: "restore";
      position: ReturnPosition;
      destination?: "saved" | "owning-worktree" | number;
    };

export function initialTreeNavigationState(): TreeNavigationState {
  return {
    selectedIndex: 0,
    scrollOffset: 0,
    previousItems: null,
    previousSelectionId: null,
    previousSelectionParentId: null,
    previousRow: null,
    previousViewportRows: 0,
    previousSelectionVisible: false,
    searchQuery: "",
    confirmationRange: null,
    confirmationPosition: null,
    savedPositions: {},
    revealedLifecycles: new Set(),
    selectionPending: false,
    restorePending: false,
  };
}

export function effectiveTreeScrollOffset(
  state: TreeNavigationState,
  snapshot: TreeNavigationSnapshot,
): number {
  return clampScrollOffset(
    state.scrollOffset,
    snapshot.rows.length,
    snapshot.viewportRows,
  );
}

function visible(
  row: number | null,
  offset: number,
  viewportRows: number,
): boolean {
  return row !== null && row >= offset && row < offset + viewportRows;
}

function select(
  state: TreeNavigationState,
  snapshot: TreeNavigationSnapshot,
  itemIndex: number,
): TreeNavigationState {
  if (itemIndex < 0 || itemIndex >= snapshot.items.length) return state;
  const row = firstRowForItem(snapshot.rows, itemIndex);
  const viewportRows =
    snapshot.viewportRowsForSelection?.(itemIndex) ?? snapshot.viewportRows;
  const offset = clampScrollOffset(
    state.scrollOffset,
    snapshot.rows.length,
    viewportRows,
  );
  const scrollOffset =
    row === null
      ? offset
      : clampScrollOffset(
          scrollToKeepVisible(row, offset, viewportRows),
          snapshot.rows.length,
          viewportRows,
        );
  const item = snapshot.items[itemIndex];
  return {
    ...state,
    selectedIndex: itemIndex,
    scrollOffset,
    previousItems: snapshot.items,
    previousSelectionId: item ? treeItemId(item, snapshot.repos) : null,
    previousSelectionParentId: item
      ? treeItemParentId(item, snapshot.repos)
      : null,
    previousRow: row,
    previousViewportRows: snapshot.viewportRows,
    previousSelectionVisible: visible(row, scrollOffset, viewportRows),
    selectionPending: true,
    restorePending: false,
  };
}

export function transitionTreeNavigation(
  state: TreeNavigationState,
  snapshot: TreeNavigationSnapshot,
  intent: TreeNavigationIntent,
): TreeNavigationState {
  switch (intent.type) {
    case "move": {
      let next = state.selectedIndex + intent.direction;
      while (next >= 0 && next < snapshot.items.length) {
        if (!isInertTreeItem(snapshot.items[next])) {
          return select(state, snapshot, next);
        }
        next += intent.direction;
      }
      return state;
    }
    case "select":
      return select(state, snapshot, intent.itemIndex);
    case "wheel": {
      const scrollOffset = clampScrollOffset(
        effectiveTreeScrollOffset(state, snapshot) + intent.delta,
        snapshot.rows.length,
        snapshot.viewportRows,
      );
      if (scrollOffset === state.scrollOffset && !state.selectionPending) {
        return state;
      }
      return {
        ...state,
        scrollOffset,
        selectionPending: false,
        restorePending: false,
        previousSelectionVisible: visible(
          firstRowForItem(snapshot.rows, state.selectedIndex),
          scrollOffset,
          snapshot.viewportRows,
        ),
      };
    }
    case "capture": {
      const saved = state.savedPositions[intent.position];
      const owningWorktreeIndex = resolveSelectedWorktreeIndex(
        snapshot.items,
        state.selectedIndex,
      );
      const selected = snapshot.items[state.selectedIndex];
      const owner =
        owningWorktreeIndex === null
          ? undefined
          : snapshot.items[owningWorktreeIndex];
      return {
        ...state,
        savedPositions: {
          ...state.savedPositions,
          [intent.position]: {
            selectedIndex:
              intent.preserveSelection && saved
                ? saved.selectedIndex
                : state.selectedIndex,
            scrollOffset: effectiveTreeScrollOffset(state, snapshot),
            owningWorktreeIndex:
              intent.preserveSelection && saved
                ? saved.owningWorktreeIndex
                : owningWorktreeIndex,
            selectedId:
              intent.preserveSelection && saved
                ? saved.selectedId
                : selected
                  ? treeItemId(selected, snapshot.repos)
                  : null,
            owningWorktreeId:
              intent.preserveSelection && saved
                ? saved.owningWorktreeId
                : owner
                  ? treeItemId(owner, snapshot.repos)
                  : null,
          },
        },
      };
    }
    case "restore": {
      const saved = state.savedPositions[intent.position];
      if (!saved) return state;
      const destination = intent.destination ?? "saved";
      const identity =
        destination === "owning-worktree"
          ? saved.owningWorktreeId
          : destination === "saved"
            ? saved.selectedId
            : null;
      const found =
        identity === null
          ? -1
          : snapshot.items.findIndex(
              (item) => treeItemId(item, snapshot.repos) === identity,
            );
      const selectedIndex =
        found >= 0
          ? found
          : destination === "saved"
            ? saved.selectedIndex
            : destination === "owning-worktree"
              ? (saved.owningWorktreeIndex ?? saved.selectedIndex)
              : destination;
      const item = snapshot.items[selectedIndex];
      return {
        ...state,
        selectedIndex,
        scrollOffset: clampScrollOffset(
          saved.scrollOffset,
          snapshot.rows.length,
          snapshot.viewportRows,
        ),
        previousItems: snapshot.items,
        previousSelectionId: item ? treeItemId(item, snapshot.repos) : null,
        previousSelectionParentId: item
          ? treeItemParentId(item, snapshot.repos)
          : null,
        selectionPending: false,
        restorePending: true,
      };
    }
    case "reconcile":
      return reconcile(state, snapshot);
  }
}

function reconcile(
  state: TreeNavigationState,
  snapshot: TreeNavigationSnapshot,
): TreeNavigationState {
  const queryChanged = state.searchQuery !== snapshot.searchQuery;
  let selectedIndex = queryChanged ? 0 : state.selectedIndex;
  let scrollOffset = queryChanged
    ? 0
    : effectiveTreeScrollOffset(state, snapshot);
  const confirmationPosition = snapshot.confirmationPosition ?? null;
  const openingConfirmation =
    confirmationPosition !== null &&
    confirmationPosition !== state.confirmationPosition;
  const savedPositions =
    openingConfirmation && state.savedPositions[confirmationPosition]
      ? {
          ...state.savedPositions,
          [confirmationPosition]: {
            ...state.savedPositions[confirmationPosition],
            scrollOffset,
          },
        }
      : state.savedPositions;

  if (!queryChanged && !state.selectionPending && !state.restorePending) {
    const recovered = resolveRecoveredSelectionIndex({
      prevTree: state.previousItems ?? snapshot.items,
      treeItems: snapshot.items,
      prevSelectionId: state.previousSelectionId,
      prevSelectionParentId: state.previousSelectionParentId,
      lifecycle: snapshot.lifecycle,
      selectedIndex,
      repos: snapshot.repos,
    });
    if (recovered !== null) selectedIndex = recovered;
  }
  selectedIndex = Math.max(
    0,
    Math.min(selectedIndex, snapshot.items.length - 1),
  );

  const revealedLifecycles = new Set(state.revealedLifecycles);
  for (const key of revealedLifecycles) {
    if (!snapshot.lifecycle.has(key)) revealedLifecycles.delete(key);
  }
  const reveal = resolveLifecycleReveal({
    rows: snapshot.rows,
    repos: snapshot.repos,
    lifecycle: snapshot.lifecycle,
    revealed: revealedLifecycles,
    scrollOffset,
    viewportRows: snapshot.viewportRows,
  });
  const revealChangedOffset =
    reveal !== null && reveal.scrollOffset !== scrollOffset;
  if (reveal) {
    revealedLifecycles.add(reveal.key);
    scrollOffset = reveal.scrollOffset;
  }

  const row = firstRowForItem(snapshot.rows, selectedIndex);
  const layoutMoved =
    row !== state.previousRow ||
    snapshot.viewportRows !== state.previousViewportRows;
  if (
    !queryChanged &&
    !revealChangedOffset &&
    !state.restorePending &&
    row !== null &&
    (state.selectionPending || (state.previousSelectionVisible && layoutMoved))
  ) {
    scrollOffset = clampScrollOffset(
      scrollToKeepVisible(row, scrollOffset, snapshot.viewportRows),
      snapshot.rows.length,
      snapshot.viewportRows,
    );
  }

  const confirmationRange = snapshot.confirming
    ? confirmationRowRange(snapshot.rows)
    : null;
  const confirmationMoved =
    confirmationRange?.start !== state.confirmationRange?.start ||
    confirmationRange?.end !== state.confirmationRange?.end ||
    snapshot.viewportRows !== state.previousViewportRows;
  if (confirmationRange && confirmationMoved && !state.restorePending) {
    scrollOffset = clampScrollOffset(
      scrollRangeToKeepVisible(
        confirmationRange,
        scrollOffset,
        snapshot.viewportRows,
      ),
      snapshot.rows.length,
      snapshot.viewportRows,
    );
  }

  const item = snapshot.items[selectedIndex];
  const previousSelectionId = item ? treeItemId(item, snapshot.repos) : null;
  const previousSelectionParentId = item
    ? treeItemParentId(item, snapshot.repos)
    : null;
  const previousSelectionVisible = visible(
    row,
    scrollOffset,
    snapshot.viewportRows,
  );
  if (
    selectedIndex === state.selectedIndex &&
    scrollOffset === state.scrollOffset &&
    state.previousItems === snapshot.items &&
    state.previousSelectionId === previousSelectionId &&
    state.previousSelectionParentId === previousSelectionParentId &&
    state.previousRow === row &&
    state.previousViewportRows === snapshot.viewportRows &&
    state.previousSelectionVisible === previousSelectionVisible &&
    state.searchQuery === snapshot.searchQuery &&
    state.confirmationPosition === confirmationPosition &&
    !confirmationMoved &&
    !reveal &&
    revealedLifecycles.size === state.revealedLifecycles.size &&
    !state.selectionPending &&
    !state.restorePending
  ) {
    return state;
  }
  return {
    ...state,
    selectedIndex,
    scrollOffset,
    previousItems: snapshot.items,
    previousSelectionId,
    previousSelectionParentId,
    previousRow: row,
    previousViewportRows: snapshot.viewportRows,
    previousSelectionVisible,
    searchQuery: snapshot.searchQuery,
    confirmationRange,
    confirmationPosition,
    savedPositions,
    revealedLifecycles,
    selectionPending: false,
    restorePending: false,
  };
}

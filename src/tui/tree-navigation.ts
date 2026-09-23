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

export type ReturnDestination = "saved" | "owning-worktree";

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
      destination?: ReturnDestination;
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

function selectionIdentity(
  snapshot: TreeNavigationSnapshot,
  itemIndex: number,
) {
  const item = snapshot.items[itemIndex];
  return {
    id: item ? treeItemId(item, snapshot.repos) : null,
    parentId: item ? treeItemParentId(item, snapshot.repos) : null,
  };
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
  const identity = selectionIdentity(snapshot, itemIndex);
  return {
    ...state,
    selectedIndex: itemIndex,
    scrollOffset,
    previousItems: snapshot.items,
    previousSelectionId: identity.id,
    previousSelectionParentId: identity.parentId,
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
      const viewportRows =
        snapshot.viewportRowsForSelection?.(state.selectedIndex) ??
        snapshot.viewportRows;
      const offset = clampScrollOffset(
        state.scrollOffset,
        snapshot.rows.length,
        viewportRows,
      );
      const scrollOffset = clampScrollOffset(
        offset + intent.delta,
        snapshot.rows.length,
        viewportRows,
      );
      if (scrollOffset === state.scrollOffset && !state.selectionPending) {
        return state;
      }
      return {
        ...state,
        scrollOffset,
        selectionPending: false,
        restorePending: false,
        previousViewportRows: viewportRows,
        previousSelectionVisible: visible(
          firstRowForItem(snapshot.rows, state.selectedIndex),
          scrollOffset,
          viewportRows,
        ),
      };
    }
    case "capture": {
      const saved = state.savedPositions[intent.position];
      const owningWorktreeIndex = resolveSelectedWorktreeIndex(
        snapshot.items,
        state.selectedIndex,
      );
      const selected = selectionIdentity(snapshot, state.selectedIndex);
      const owner =
        owningWorktreeIndex === null
          ? undefined
          : snapshot.items[owningWorktreeIndex];
      const currentSelection = {
        selectedIndex: state.selectedIndex,
        owningWorktreeIndex,
        selectedId: selected.id,
        owningWorktreeId: owner ? treeItemId(owner, snapshot.repos) : null,
      };
      const selection =
        intent.preserveSelection && saved ? saved : currentSelection;
      return {
        ...state,
        savedPositions: {
          ...state.savedPositions,
          [intent.position]: {
            ...selection,
            scrollOffset: effectiveTreeScrollOffset(state, snapshot),
          },
        },
      };
    }
    case "restore": {
      const saved = state.savedPositions[intent.position];
      if (!saved) return state;
      const destination = intent.destination ?? "saved";
      let identity = saved.selectedId;
      let selectedIndex = saved.selectedIndex;
      if (destination === "owning-worktree") {
        identity = saved.owningWorktreeId;
        selectedIndex = saved.owningWorktreeIndex ?? saved.selectedIndex;
      }
      if (identity !== null) {
        const found = snapshot.items.findIndex(
          (item) => treeItemId(item, snapshot.repos) === identity,
        );
        if (found >= 0) selectedIndex = found;
      }
      const selectedIdentity = selectionIdentity(snapshot, selectedIndex);
      return {
        ...state,
        selectedIndex,
        // The snapshot can still be in Confirm mode, whose footer is shorter
        // than the destination mode's. Reconcile clamps after that mode lands.
        scrollOffset: saved.scrollOffset,
        previousItems: snapshot.items,
        previousSelectionId: selectedIdentity.id,
        previousSelectionParentId: selectedIdentity.parentId,
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
  // A restore and the mode change can commit separately. Keep the saved
  // offset until the destination layout supplies its final viewport height.
  if (state.restorePending && snapshot.confirming) return state;

  const queryChanged = state.searchQuery !== snapshot.searchQuery;
  let selectedIndex = queryChanged ? 0 : state.selectedIndex;
  if (!queryChanged && !state.selectionPending) {
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
  // The render that triggered recovery still budgets the footer for the old
  // index. Use the recovered item's viewport for every scroll decision here.
  const viewportRows =
    snapshot.viewportRowsForSelection?.(selectedIndex) ?? snapshot.viewportRows;
  let scrollOffset = queryChanged
    ? 0
    : clampScrollOffset(state.scrollOffset, snapshot.rows.length, viewportRows);
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
    viewportRows,
  });
  const revealChangedOffset =
    reveal !== null && reveal.scrollOffset !== scrollOffset;
  if (reveal) {
    revealedLifecycles.add(reveal.key);
    scrollOffset = reveal.scrollOffset;
  }

  const row = firstRowForItem(snapshot.rows, selectedIndex);
  const layoutMoved =
    row !== state.previousRow || viewportRows !== state.previousViewportRows;
  if (
    !queryChanged &&
    !revealChangedOffset &&
    !state.restorePending &&
    row !== null &&
    (state.selectionPending || (state.previousSelectionVisible && layoutMoved))
  ) {
    scrollOffset = clampScrollOffset(
      scrollToKeepVisible(row, scrollOffset, viewportRows),
      snapshot.rows.length,
      viewportRows,
    );
  }

  const confirmationRange = snapshot.confirming
    ? confirmationRowRange(snapshot.rows)
    : null;
  const confirmationMoved =
    confirmationRange?.start !== state.confirmationRange?.start ||
    confirmationRange?.end !== state.confirmationRange?.end ||
    viewportRows !== state.previousViewportRows;
  if (confirmationRange && confirmationMoved && !state.restorePending) {
    scrollOffset = clampScrollOffset(
      scrollRangeToKeepVisible(confirmationRange, scrollOffset, viewportRows),
      snapshot.rows.length,
      viewportRows,
    );
  }

  const selectedIdentity = selectionIdentity(snapshot, selectedIndex);
  const previousSelectionId = selectedIdentity.id;
  const previousSelectionParentId = selectedIdentity.parentId;
  const previousSelectionVisible = visible(row, scrollOffset, viewportRows);
  if (
    selectedIndex === state.selectedIndex &&
    scrollOffset === state.scrollOffset &&
    state.previousItems === snapshot.items &&
    state.previousSelectionId === previousSelectionId &&
    state.previousSelectionParentId === previousSelectionParentId &&
    state.previousRow === row &&
    state.previousViewportRows === viewportRows &&
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
    previousViewportRows: viewportRows,
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

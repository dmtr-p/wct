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
  confirmationSlot?: ReturnSlot | null;
}

/** Action-keyed slot for a saved tree selection and viewport. */
export type ReturnSlot = "down" | "close" | "delete-project" | "kill" | "up";

export type ReturnDestination = "saved" | "owning-worktree";

interface SavedPosition {
  selectedIndex: number;
  scrollOffset: number;
  owningWorktreeIndex: number | null;
  selectedId: string | null;
  owningWorktreeId: string | null;
}

interface PreviousLayout {
  items: TreeItem[] | null;
  selectionId: string | null;
  selectionParentId: string | null;
  row: number | null;
  viewportRows: number;
  selectionVisible: boolean;
}

export interface TreeNavigationState {
  selectedIndex: number;
  scrollOffset: number;
  previousLayout: PreviousLayout;
  searchQuery: string;
  confirmationRange: { start: number; end: number } | null;
  confirmationSlot: ReturnSlot | null;
  savedPositions: Partial<Record<ReturnSlot, SavedPosition>>;
  revealedLifecycles: ReadonlySet<string>;
  selectionPending: boolean;
  restorePending: boolean;
}

export type TreeNavigationIntent =
  | { type: "reconcile" }
  | { type: "move"; direction: 1 | -1 }
  | { type: "select"; itemIndex: number }
  | { type: "wheel"; delta: number }
  | { type: "capture"; slot: ReturnSlot; preserveSelection?: boolean }
  | {
      type: "restore";
      slot: ReturnSlot;
      destination?: ReturnDestination;
    };

export function initialTreeNavigationState(): TreeNavigationState {
  return {
    selectedIndex: 0,
    scrollOffset: 0,
    previousLayout: {
      items: null,
      selectionId: null,
      selectionParentId: null,
      row: null,
      viewportRows: 0,
      selectionVisible: false,
    },
    searchQuery: "",
    confirmationRange: null,
    confirmationSlot: null,
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
    previousLayout: {
      items: snapshot.items,
      selectionId: identity.id,
      selectionParentId: identity.parentId,
      row,
      viewportRows: snapshot.viewportRows,
      selectionVisible: visible(row, scrollOffset, viewportRows),
    },
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
        previousLayout: {
          ...state.previousLayout,
          viewportRows,
          selectionVisible: visible(
            firstRowForItem(snapshot.rows, state.selectedIndex),
            scrollOffset,
            viewportRows,
          ),
        },
      };
    }
    case "capture": {
      const saved = state.savedPositions[intent.slot];
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
          [intent.slot]: {
            ...selection,
            scrollOffset: effectiveTreeScrollOffset(state, snapshot),
          },
        },
      };
    }
    case "restore": {
      const saved = state.savedPositions[intent.slot];
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
      // Up's form modal keeps the live viewport as refreshes and resizes
      // reshape the tree. Confirmations restore their captured viewport.
      const scrollOffset =
        intent.slot === "up"
          ? effectiveTreeScrollOffset(state, snapshot)
          : saved.scrollOffset;
      return {
        ...state,
        selectedIndex,
        // Confirm can still be active here; its footer is shorter than the
        // destination's. Reconcile clamps its saved offset after mode changes.
        scrollOffset,
        previousLayout: {
          ...state.previousLayout,
          items: snapshot.items,
          selectionId: selectedIdentity.id,
          selectionParentId: selectedIdentity.parentId,
        },
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
  if (!queryChanged) {
    // A deliberate selection records its identity in previousLayout. If the
    // tree changes before this reconciliation, recover that selected item by
    // identity before using its new index for viewport decisions.
    const recovered = resolveRecoveredSelectionIndex({
      prevTree: state.previousLayout.items ?? snapshot.items,
      treeItems: snapshot.items,
      prevSelectionId: state.previousLayout.selectionId,
      prevSelectionParentId: state.previousLayout.selectionParentId,
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
  const confirmationSlot = snapshot.confirmationSlot ?? null;
  const openingConfirmation =
    confirmationSlot !== null && confirmationSlot !== state.confirmationSlot;
  const savedPositions =
    openingConfirmation && state.savedPositions[confirmationSlot]
      ? {
          ...state.savedPositions,
          [confirmationSlot]: {
            ...state.savedPositions[confirmationSlot],
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
    row !== state.previousLayout.row ||
    viewportRows !== state.previousLayout.viewportRows;
  if (
    !queryChanged &&
    !revealChangedOffset &&
    !state.restorePending &&
    row !== null &&
    (state.selectionPending ||
      (state.previousLayout.selectionVisible && layoutMoved))
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
    viewportRows !== state.previousLayout.viewportRows;
  if (confirmationRange && confirmationMoved && !state.restorePending) {
    scrollOffset = clampScrollOffset(
      scrollRangeToKeepVisible(confirmationRange, scrollOffset, viewportRows),
      snapshot.rows.length,
      viewportRows,
    );
  }

  const selectedIdentity = selectionIdentity(snapshot, selectedIndex);
  const previousLayout: PreviousLayout = {
    items: snapshot.items,
    selectionId: selectedIdentity.id,
    selectionParentId: selectedIdentity.parentId,
    row,
    viewportRows,
    selectionVisible: visible(row, scrollOffset, viewportRows),
  };
  if (
    selectedIndex === state.selectedIndex &&
    scrollOffset === state.scrollOffset &&
    state.previousLayout.items === previousLayout.items &&
    state.previousLayout.selectionId === previousLayout.selectionId &&
    state.previousLayout.selectionParentId ===
      previousLayout.selectionParentId &&
    state.previousLayout.row === previousLayout.row &&
    state.previousLayout.viewportRows === previousLayout.viewportRows &&
    state.previousLayout.selectionVisible === previousLayout.selectionVisible &&
    state.searchQuery === snapshot.searchQuery &&
    state.confirmationSlot === confirmationSlot &&
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
    previousLayout,
    searchQuery: snapshot.searchQuery,
    confirmationRange,
    confirmationSlot,
    savedPositions,
    revealedLifecycles,
    selectionPending: false,
    restorePending: false,
  };
}

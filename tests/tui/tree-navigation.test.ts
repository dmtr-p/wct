import { describe, expect, test } from "vitest";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { type LifecycleState, lifecycleKey } from "../../src/tui/lifecycle";
import type { TreeRow } from "../../src/tui/tree-helpers";
import {
  effectiveTreeScrollOffset,
  initialTreeNavigationState,
  type TreeNavigationSnapshot,
  type TreeNavigationState,
  transitionTreeNavigation,
} from "../../src/tui/tree-navigation";
import type { TreeItem } from "../../src/tui/types";

const repos: RepoInfo[] = [
  {
    id: "one",
    repoPath: "/one",
    project: "shared",
    profileNames: [],
    worktrees: [
      {
        branch: "main",
        path: "/one/main",
        isMainWorktree: true,
        changedFiles: 0,
        sync: null,
      },
      {
        branch: "feature",
        path: "/one/feature",
        isMainWorktree: false,
        changedFiles: 0,
        sync: null,
      },
    ],
  },
  {
    id: "two",
    repoPath: "/two",
    project: "shared",
    profileNames: [],
    worktrees: [
      {
        branch: "feature",
        path: "/two/feature",
        isMainWorktree: false,
        changedFiles: 0,
        sync: null,
      },
    ],
  },
];

const baseItems: TreeItem[] = [
  { type: "repo", repoIndex: 0 },
  { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
  { type: "worktree", repoIndex: 0, worktreeIndex: 1 },
  { type: "repo", repoIndex: 1 },
  { type: "worktree", repoIndex: 1, worktreeIndex: 0 },
];

function rowsFor(items: TreeItem[]): TreeRow[] {
  return items.map((item, itemIndex) => ({
    kind: item.type === "repo" ? "repo" : "worktree",
    itemIndex,
  })) as TreeRow[];
}

function snapshot(
  overrides: Partial<TreeNavigationSnapshot> = {},
): TreeNavigationSnapshot {
  return {
    items: baseItems,
    repos,
    rows: rowsFor(baseItems),
    viewportRows: 2,
    searchQuery: "",
    lifecycle: new Map(),
    confirming: false,
    ...overrides,
  };
}

function step(
  state: TreeNavigationState,
  layout: TreeNavigationSnapshot,
  intent: Parameters<typeof transitionTreeNavigation>[2],
) {
  return transitionTreeNavigation(state, layout, intent);
}

function settled(layout: TreeNavigationSnapshot) {
  return step(initialTreeNavigationState(), layout, { type: "reconcile" });
}

describe("tree navigation sequences", () => {
  test("selection uses the destination footer height for a minimal reveal", () => {
    const layout = snapshot({
      viewportRows: 2,
      viewportRowsForSelection: (itemIndex) => (itemIndex === 2 ? 3 : 2),
    });
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 2 });
    expect(state.selectedIndex).toBe(2);
    expect(state.scrollOffset).toBe(0);
    state = step(state, snapshot({ viewportRows: 3 }), { type: "reconcile" });
    expect(state.scrollOffset).toBe(0);
  });

  test("identity recovery uses the recovered repository's footer height", () => {
    const initial = snapshot({
      viewportRows: 2,
      // Repo two has no error footer; repo one's error leaves two tree rows.
      viewportRowsForSelection: (itemIndex) => (itemIndex === 3 ? 3 : 2),
    });
    let state = settled(initial);
    state = step(state, initial, { type: "select", itemIndex: 3 });
    const before = { ...initial, viewportRows: 3 };
    state = step(state, before, { type: "reconcile" });
    expect(state.scrollOffset).toBe(1);

    const insertedItems: TreeItem[] = [
      ...baseItems.slice(0, 3),
      { type: "worktree", repoIndex: 0, worktreeIndex: 1 },
      ...baseItems.slice(3),
    ];
    const after = snapshot({
      items: insertedItems,
      rows: rowsFor(insertedItems),
      // The stale index now points into repo one, which has an error footer.
      viewportRows: 2,
      viewportRowsForSelection: (itemIndex) => (itemIndex === 4 ? 3 : 2),
    });
    state = step(state, after, { type: "reconcile" });
    expect(state.selectedIndex).toBe(4);
    expect(state.scrollOffset).toBe(2);

    const committed = { ...after, viewportRows: 3 };
    state = step(state, committed, { type: "reconcile" });
    expect(state.scrollOffset).toBe(2);
  });

  test("a visible lifecycle row does not suppress selection visibility after insertion", () => {
    const layout = snapshot({ viewportRows: 3 });
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 2 });
    state = step(state, layout, { type: "reconcile" });
    const phase = { _tag: "Preparing" } as const;
    const lifecycle: LifecycleState = new Map([
      [
        lifecycleKey("/one", "main"),
        {
          operation: "up",
          repoPath: "/one",
          project: "shared",
          branch: "main",
          phase,
        },
      ],
    ]);
    const active = snapshot({
      viewportRows: 3,
      lifecycle,
      rows: [
        ...rowsFor(baseItems).slice(0, 2),
        {
          kind: "lifecycle-progress",
          itemIndex: null,
          repoIndex: 0,
          branch: "main",
          phase,
        },
        ...rowsFor(baseItems).slice(2),
      ],
    });
    state = step(state, active, { type: "reconcile" });
    expect(state.revealedLifecycles.has(lifecycleKey("/one", "main"))).toBe(
      true,
    );
    expect(state.selectedIndex).toBe(2);
    expect(state.scrollOffset).toBe(1);
  });

  test("a lifecycle reveal that moves the viewport keeps precedence over selection", () => {
    const layout = snapshot({ viewportRows: 2 });
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 4 });
    state = step(state, layout, { type: "reconcile" });
    const phase = { _tag: "Preparing" } as const;
    const lifecycle: LifecycleState = new Map([
      [
        lifecycleKey("/one", "main"),
        {
          operation: "up",
          repoPath: "/one",
          project: "shared",
          branch: "main",
          phase,
        },
      ],
    ]);
    const active = snapshot({
      lifecycle,
      rows: [
        ...rowsFor(baseItems).slice(0, 2),
        {
          kind: "lifecycle-progress",
          itemIndex: null,
          repoIndex: 0,
          branch: "main",
          phase,
        },
        ...rowsFor(baseItems).slice(2),
      ],
    });
    state = step(state, active, { type: "reconcile" });
    expect(state.scrollOffset).toBe(2);
    expect(state.selectedIndex).toBe(4);
  });

  test("wheel then refresh leaves an offscreen selection and offset alone", () => {
    const layout = snapshot();
    let state = settled(layout);
    state = step(state, layout, { type: "wheel", delta: 3 });
    const refreshed = snapshot({ items: [...baseItems] });
    state = step(state, refreshed, { type: "reconcile" });
    expect(state.selectedIndex).toBe(0);
    expect(state.scrollOffset).toBe(3);
    expect(step(state, refreshed, { type: "reconcile" })).toBe(state);
  });

  test("selection then wheel then refresh does not recover the old selection", () => {
    const layout = snapshot();
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 2 });
    state = step(state, layout, { type: "wheel", delta: 2 });
    state = step(state, snapshot({ items: [...baseItems] }), {
      type: "reconcile",
    });
    expect(state.selectedIndex).toBe(2);
    expect(state.scrollOffset).toBe(3);
  });

  test("a wheel after selection shrinks the footer viewport is not undone", () => {
    const layout = snapshot({
      viewportRows: 3,
      viewportRowsForSelection: (itemIndex) => (itemIndex === 2 ? 2 : 3),
    });
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 2 });
    expect(state.scrollOffset).toBe(1);
    state = step(state, layout, { type: "wheel", delta: -1 });
    expect(state.scrollOffset).toBe(0);

    const committed = snapshot({ viewportRows: 2 });
    state = step(state, committed, { type: "reconcile" });
    expect(state.selectedIndex).toBe(2);
    expect(state.scrollOffset).toBe(0);
    expect(step(state, committed, { type: "reconcile" })).toBe(state);
  });

  test("a queued wheel can scroll to the new bottom after the footer shrinks", () => {
    const rows: TreeRow[] = [
      ...rowsFor(baseItems),
      { kind: "detail", itemIndex: 4 },
    ];
    const layout = snapshot({
      rows,
      viewportRows: 3,
      viewportRowsForSelection: (itemIndex) => (itemIndex === 4 ? 2 : 3),
    });
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 4 });
    expect(state.scrollOffset).toBe(3);
    state = step(state, layout, { type: "wheel", delta: 1 });
    expect(state.scrollOffset).toBe(4);

    state = step(state, snapshot({ rows, viewportRows: 2 }), {
      type: "reconcile",
    });
    expect(state.scrollOffset).toBe(4);
  });

  test("changed search resets cursor and offset; unchanged search does not", () => {
    const layout = snapshot();
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 4 });
    state = step(state, layout, { type: "wheel", delta: -1 });
    state = step(state, snapshot({ searchQuery: "feature" }), {
      type: "reconcile",
    });
    expect([state.selectedIndex, state.scrollOffset]).toEqual([0, 0]);
    state = step(state, snapshot({ searchQuery: "feature" }), {
      type: "wheel",
      delta: 2,
    });
    state = step(state, snapshot({ searchQuery: "feature" }), {
      type: "reconcile",
    });
    expect(state.scrollOffset).toBe(2);
    expect(
      step(state, snapshot({ searchQuery: "feature" }), {
        type: "reconcile",
      }),
    ).toBe(state);
  });

  test("cursor-only search movement leaves selection and viewport unchanged", () => {
    const layout = snapshot({ searchQuery: "feature" });
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 4 });
    state = step(state, layout, { type: "wheel", delta: -1 });
    state = step(state, layout, { type: "reconcile" });
    const beforeCursorMove = state;

    // The text editor moves its insertion cursor; navigation sees the same query.
    state = step(state, layout, { type: "reconcile" });
    expect(state).toBe(beforeCursorMove);
    expect([state.selectedIndex, state.scrollOffset]).toEqual([4, 2]);
  });

  test("reflow keeps a previously visible selection in view", () => {
    const layout = snapshot({ viewportRows: 3 });
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 2 });
    state = step(state, layout, { type: "reconcile" });
    const withExtraRow = snapshot({
      rows: [
        ...rowsFor(baseItems).slice(0, 2),
        {
          kind: "worktree-stats",
          itemIndex: null,
          repoIndex: 0,
          worktreeIndex: 0,
        },
        ...rowsFor(baseItems).slice(2),
      ],
      viewportRows: 2,
    });
    state = step(state, withExtraRow, { type: "reconcile" });
    expect(state.scrollOffset).toBe(2);
    state = step(state, withExtraRow, { type: "wheel", delta: 3 });
    const reflowAgain = snapshot({ ...withExtraRow, viewportRows: 1 });
    state = step(state, reflowAgain, { type: "reconcile" });
    expect(state.scrollOffset).toBe(4);
  });

  test("registry identity survives insertion and remains distinct from workspace identity", () => {
    const layout = snapshot();
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 4 });
    state = step(state, layout, { type: "reconcile" });
    const inserted = [{ type: "repo", repoIndex: 0 } as TreeItem, ...baseItems];
    state = step(
      state,
      snapshot({ items: inserted, rows: rowsFor(inserted) }),
      {
        type: "reconcile",
      },
    );
    expect(state.selectedIndex).toBe(5);
    expect(state.previousSelectionId).toBe("wt:two/feature");
  });

  test("keyboard skips inert detail rows", () => {
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
      {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane-header",
        label: "panes",
      },
      { type: "worktree", repoIndex: 0, worktreeIndex: 1 },
    ];
    const layout = snapshot({
      items,
      rows: [
        { kind: "repo", itemIndex: 0 },
        { kind: "worktree", itemIndex: 1 },
        { kind: "detail", itemIndex: 2 },
        { kind: "worktree", itemIndex: 3 },
      ],
    });
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 1 });
    state = step(state, layout, { type: "move", direction: 1 });
    expect(state.selectedIndex).toBe(3);
    state = step(state, layout, { type: "move", direction: -1 });
    expect(state.selectedIndex).toBe(1);
  });

  test("suppressed detail selection returns to its owning Workspace while reveal owns scrolling", () => {
    const detail: TreeItem = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane-header",
      label: "panes",
    };
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
      detail,
      ...baseItems.slice(2),
    ];
    const before = snapshot({
      items,
      rows: [
        { kind: "repo", itemIndex: 0 },
        { kind: "worktree", itemIndex: 1 },
        { kind: "detail", itemIndex: 2 },
        { kind: "worktree", itemIndex: 3 },
        { kind: "repo", itemIndex: 4 },
        { kind: "worktree", itemIndex: 5 },
      ],
    });
    let state = settled(before);
    state = step(state, before, { type: "select", itemIndex: 2 });
    state = step(state, before, { type: "reconcile" });
    const phase = { _tag: "Preparing" } as const;
    const lifecycle: LifecycleState = new Map([
      [
        lifecycleKey("/one", "main"),
        {
          operation: "up",
          repoPath: "/one",
          project: "shared",
          branch: "main",
          phase,
        },
      ],
    ]);
    const after = snapshot({
      lifecycle,
      rows: [
        { kind: "repo", itemIndex: 0 },
        { kind: "worktree", itemIndex: 1 },
        {
          kind: "lifecycle-progress",
          itemIndex: null,
          repoIndex: 0,
          branch: "main",
          phase,
        },
        ...rowsFor(baseItems).slice(2),
      ],
      items: baseItems,
    });
    state = step(state, after, { type: "reconcile" });
    expect(state.selectedIndex).toBe(1);
    expect(state.revealedLifecycles.has(lifecycleKey("/one", "main"))).toBe(
      true,
    );
  });

  test("Up restoration still recovers a detail suppressed by its lifecycle", () => {
    const detail: TreeItem = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pr",
      label: "#42",
      meta: { rollupState: null },
    };
    const beforeItems = [
      ...baseItems.slice(0, 2),
      detail,
      ...baseItems.slice(2),
    ];
    const beforeRows = rowsFor(beforeItems);
    beforeRows[2] = { kind: "detail", itemIndex: 2 };
    const before = snapshot({ items: beforeItems, rows: beforeRows });
    let state = settled(before);
    state = step(state, before, { type: "select", itemIndex: 2 });
    state = step(state, before, { type: "capture", position: "up" });
    state = step(state, before, { type: "restore", position: "up" });
    expect(state.restorePending).toBe(true);
    expect(state.previousSelectionParentId).toBe("wt:one/main");

    const phase = { _tag: "Preparing" } as const;
    const key = lifecycleKey("/one", "main");
    const lifecycle: LifecycleState = new Map([
      [
        key,
        {
          operation: "up",
          repoPath: "/one",
          project: "shared",
          branch: "main",
          phase,
        },
      ],
    ]);
    const duringUp = snapshot({
      items: baseItems,
      rows: [
        ...rowsFor(baseItems).slice(0, 2),
        {
          kind: "lifecycle-progress",
          itemIndex: null,
          repoIndex: 0,
          branch: "main",
          phase,
        },
        ...rowsFor(baseItems).slice(2),
      ],
      lifecycle,
    });
    state = step(state, duringUp, { type: "reconcile" });
    expect(state.selectedIndex).toBe(1);
    expect(state.previousSelectionId).toBe("wt:one/main");
    expect(state.revealedLifecycles.has(key)).toBe(true);
    expect(step(state, duringUp, { type: "reconcile" })).toBe(state);
  });

  test("lifecycle reveal wins over detail recovery and is one-shot", () => {
    const layout = snapshot();
    let state = settled(layout);
    state = step(state, layout, { type: "wheel", delta: 3 });
    const key = lifecycleKey("/one", "main");
    const lifecycle: LifecycleState = new Map([
      [
        key,
        {
          operation: "up",
          repoPath: "/one",
          project: "shared",
          branch: "main",
          phase: { _tag: "Preparing" },
        },
      ],
    ]);
    const active = snapshot({
      lifecycle,
      rows: [
        ...rowsFor(baseItems).slice(0, 2),
        {
          kind: "lifecycle-progress",
          itemIndex: null,
          repoIndex: 0,
          branch: "main",
          phase: { _tag: "Preparing" },
        },
        ...rowsFor(baseItems).slice(2),
      ],
    });
    state = step(state, active, { type: "reconcile" });
    expect(state.scrollOffset).toBe(2);
    state = step(state, active, { type: "wheel", delta: 2 });
    state = step(state, active, { type: "reconcile" });
    expect(state.scrollOffset).toBe(4);
    expect(state.revealedLifecycles.has(key)).toBe(true);
    state = step(state, snapshot(), { type: "reconcile" });
    expect(state.revealedLifecycles.has(key)).toBe(false);
    state = step(state, active, { type: "reconcile" });
    expect(state.revealedLifecycles.has(key)).toBe(true);
  });

  test("unavailable lifecycle rows wait; simultaneous operations reveal in order", () => {
    const first = lifecycleKey("/one", "main");
    const second = lifecycleKey("/two", "feature");
    const phase = { _tag: "Preparing" } as const;
    const lifecycle: LifecycleState = new Map([
      [
        first,
        {
          operation: "up",
          repoPath: "/one",
          project: "shared",
          branch: "main",
          phase,
        },
      ],
      [
        second,
        {
          operation: "up",
          repoPath: "/two",
          project: "shared",
          branch: "feature",
          phase,
        },
      ],
    ]);
    const rows: TreeRow[] = [
      ...rowsFor(baseItems),
      {
        kind: "lifecycle-progress",
        itemIndex: null,
        repoIndex: 1,
        branch: "feature",
        phase,
      },
    ];
    let state = settled(snapshot());
    state = step(state, snapshot({ lifecycle, rows }), { type: "reconcile" });
    expect(state.revealedLifecycles.has(first)).toBe(false);
    expect(state.revealedLifecycles.has(second)).toBe(true);
    const visible = snapshot({
      lifecycle,
      rows: [
        {
          kind: "lifecycle-progress",
          itemIndex: null,
          repoIndex: 0,
          branch: "main",
          phase,
        },
        ...rows,
      ],
    });
    state = step(state, visible, { type: "reconcile" });
    expect(state.revealedLifecycles.has(first)).toBe(true);
  });

  test("confirmation capture and restore keep the prior viewport", () => {
    const layout = snapshot();
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 4 });
    state = step(state, layout, { type: "wheel", delta: -1 });
    state = step(state, layout, { type: "capture", position: "close" });
    const confirming = snapshot({
      confirming: true,
      rows: [
        ...rowsFor(baseItems).slice(0, 5),
        { kind: "confirmation", itemIndex: null, partIndex: 0 },
        { kind: "confirmation", itemIndex: null, partIndex: 1 },
      ],
    });
    state = step(state, confirming, { type: "reconcile" });
    expect(state.scrollOffset).toBe(5);
    state = step(state, confirming, {
      type: "restore",
      position: "close",
      destination: "owning-worktree",
    });
    expect(state.selectedIndex).toBe(4);
    expect(state.scrollOffset).toBe(2);
    state = step(state, layout, { type: "reconcile" });
    expect(effectiveTreeScrollOffset(state, layout)).toBe(2);
  });

  test("Up modal return keeps a viewport adjusted by terminal resize", () => {
    const layout = snapshot();
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 1 });
    state = step(state, layout, { type: "wheel", delta: 3 });
    state = step(state, layout, { type: "capture", position: "up" });
    expect(state.scrollOffset).toBe(3);

    const taller = snapshot({ viewportRows: 3 });
    state = step(state, taller, { type: "reconcile" });
    expect(state.scrollOffset).toBe(2);
    state = step(state, layout, { type: "reconcile" });
    expect(state.scrollOffset).toBe(2);

    // Cancel and submit both use the same Up restore intent.
    state = step(state, layout, { type: "restore", position: "up" });
    expect(state.selectedIndex).toBe(1);
    expect(state.scrollOffset).toBe(2);
    state = step(state, layout, { type: "reconcile" });
    expect(state.scrollOffset).toBe(2);
  });

  test("disappearing confirmation rows leave the saved return position available", () => {
    const layout = snapshot();
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 4 });
    state = step(state, layout, { type: "capture", position: "down" });
    const confirming = snapshot({
      confirming: true,
      rows: [
        ...rowsFor(baseItems),
        { kind: "confirmation", itemIndex: null, partIndex: 0 },
      ],
    });
    state = step(state, confirming, { type: "reconcile" });
    state = step(state, snapshot({ confirming: true }), { type: "reconcile" });
    state = step(state, layout, { type: "restore", position: "down" });
    expect(state.selectedIndex).toBe(4);
    expect(state.scrollOffset).toBe(3);
  });

  test("disappearing anchor restores the viewport using the destination footer", () => {
    // Navigate reserves a repository-error row, while Confirm has no footer.
    const navigate = snapshot({ viewportRows: 2 });
    let state = settled(navigate);
    state = step(state, navigate, { type: "select", itemIndex: 4 });
    expect(state.scrollOffset).toBe(3);
    state = step(state, navigate, { type: "capture", position: "down" });

    const confirming = snapshot({
      viewportRows: 3,
      confirming: true,
      rows: [
        ...rowsFor(baseItems),
        { kind: "confirmation", itemIndex: null, partIndex: 0 },
      ],
    });
    state = step(state, confirming, { type: "reconcile" });

    const remainingItems = baseItems.slice(0, 4);
    const missingAnchor = snapshot({
      items: remainingItems,
      rows: rowsFor(remainingItems),
      viewportRows: 3,
      confirming: true,
    });
    state = step(state, missingAnchor, { type: "reconcile" });
    state = step(state, missingAnchor, { type: "restore", position: "down" });
    state = step(state, missingAnchor, { type: "reconcile" });
    expect(state.scrollOffset).toBe(3);
    expect(effectiveTreeScrollOffset(state, missingAnchor)).toBe(1);

    const returned = snapshot({
      items: remainingItems,
      rows: rowsFor(remainingItems),
      viewportRows: 2,
    });
    state = step(state, returned, { type: "reconcile" });
    expect(state.selectedIndex).toBe(3);
    expect(state.scrollOffset).toBe(2);
    expect(effectiveTreeScrollOffset(state, returned)).toBe(2);
  });

  test("force confirmation refreshes return viewport without replacing its saved selection", () => {
    const layout = snapshot();
    let state = settled(layout);
    state = step(state, layout, { type: "select", itemIndex: 4 });
    state = step(state, layout, { type: "capture", position: "close" });
    state = step(state, layout, { type: "select", itemIndex: 1 });
    state = step(state, layout, { type: "wheel", delta: 1 });
    state = step(state, layout, {
      type: "capture",
      position: "close",
      preserveSelection: true,
    });
    state = step(state, layout, { type: "restore", position: "close" });
    expect(state.selectedIndex).toBe(4);
    expect(state.scrollOffset).toBe(2);
  });

  test("empty trees and zero-height viewports settle", () => {
    const empty = snapshot({ items: [], rows: [], viewportRows: 0 });
    let state = settled(empty);
    state = step(state, empty, { type: "move", direction: 1 });
    state = step(state, empty, { type: "wheel", delta: 3 });
    expect(state.selectedIndex).toBe(0);
    expect(state.scrollOffset).toBe(0);
    expect(step(state, empty, { type: "reconcile" })).toBe(state);
  });

  test("shrinking rows clamps the independent offset and replay is deterministic", () => {
    const layout = snapshot();
    const intents = [
      { type: "move", direction: 1 },
      { type: "wheel", delta: 3 },
      { type: "reconcile" },
    ] as const;
    const replay = () =>
      intents.reduce<TreeNavigationState>(
        (state, intent) => step(state, layout, intent),
        settled(layout),
      );
    expect(replay()).toEqual(replay());
    const short = snapshot({
      items: [{ type: "repo", repoIndex: 0 }],
      rows: [{ kind: "repo", itemIndex: 0 }],
    });
    const state = step(replay(), short, { type: "reconcile" });
    expect(state.scrollOffset).toBe(0);
    expect(state.selectedIndex).toBe(0);
  });
});

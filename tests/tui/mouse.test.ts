import { describe, expect, test } from "vitest";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import {
  DOUBLE_CLICK_INTERVAL_MS,
  detectDoubleClick,
  getTreeRenderedRows,
  parseMouseClick,
  parseMouseScroll,
  resolveTreeDoubleClickAction,
  resolveTreeMouseTarget,
  resolveTreeViewportHeight,
  revealTreeItem,
  scrollTreeViewport,
} from "../../src/tui/mouse";
import type { PendingAction, TreeItem } from "../../src/tui/types";

function fakeRepo(id: string, branches: string[], changedFiles = 0): RepoInfo {
  return {
    id,
    repoPath: `/tmp/${id}`,
    project: id,
    worktrees: branches.map((branch) => ({
      branch,
      path: `/tmp/${id}/${branch}`,
      isMainWorktree: branch === "main",
      changedFiles,
      sync: null,
    })),
    profileNames: [],
    ideDefaults: { baseNoIde: true, profileNoIde: {} },
  };
}

describe("parseMouseClick", () => {
  test("parses Ink-stripped and raw SGR left-button presses", () => {
    expect(parseMouseClick("[<0;12;7M")).toEqual({ column: 12, row: 7 });
    expect(parseMouseClick("\u001B[<0;3;4M")).toEqual({ column: 3, row: 4 });
  });

  test("ignores releases, other buttons, and keyboard input", () => {
    expect(parseMouseClick("[<0;12;7m")).toBeNull();
    expect(parseMouseClick("[<2;12;7M")).toBeNull();
    expect(parseMouseClick("q")).toBeNull();
  });

  test("ignores wheel, motion, and modified-button events", () => {
    expect(parseMouseClick("[<64;12;7M")).toBeNull();
    expect(parseMouseClick("[<65;12;7M")).toBeNull();
    expect(parseMouseClick("[<32;12;7M")).toBeNull();
    expect(parseMouseClick("[<4;12;7M")).toBeNull();
  });

  test("parses only unmodified wheel presses as scrolling", () => {
    expect(parseMouseScroll("[<64;12;7M")).toEqual({
      column: 12,
      direction: -1,
      row: 7,
    });
    expect(parseMouseScroll("\u001B[<65;3;4M")).toEqual({
      column: 3,
      direction: 1,
      row: 4,
    });
    expect(parseMouseScroll("[<68;12;7M")).toBeNull();
    expect(parseMouseScroll("[<32;12;7M")).toBeNull();
    expect(parseMouseScroll("[<0;12;7M")).toBeNull();
  });
});

describe("detectDoubleClick", () => {
  test("detects and consumes two clicks on the same item within the window", () => {
    const first = detectDoubleClick(null, "wt:repo/main", 1_000);
    expect(first.isDoubleClick).toBe(false);

    const second = detectDoubleClick(first.history, "wt:repo/main", 1_200);
    expect(second).toEqual({ isDoubleClick: true, history: null });
  });

  test("does not combine clicks on different items or outside the window", () => {
    const previous = { targetId: "wt:repo/main", timestamp: 1_000 };

    expect(detectDoubleClick(previous, "detail:repo/main/pr", 1_100)).toEqual({
      isDoubleClick: false,
      history: { targetId: "detail:repo/main/pr", timestamp: 1_100 },
    });
    expect(
      detectDoubleClick(
        previous,
        "wt:repo/main",
        1_000 + DOUBLE_CLICK_INTERVAL_MS + 1,
      ).isDoubleClick,
    ).toBe(false);
  });
});

describe("resolveTreeDoubleClickAction", () => {
  const repos = [fakeRepo("repo-a", ["main"])];

  test("expands or collapses worktree rows", () => {
    const worktree: TreeItem = {
      type: "worktree",
      repoIndex: 0,
      worktreeIndex: 0,
    };

    expect(resolveTreeDoubleClickAction(worktree, repos, new Set())).toEqual({
      type: "expand-worktree",
      worktreeKey: "repo-a/main",
    });
    expect(
      resolveTreeDoubleClickAction(worktree, repos, new Set(["repo-a/main"])),
    ).toEqual({ type: "collapse-worktree", worktreeKey: "repo-a/main" });
  });

  test("activates PR and pane rows only", () => {
    const action = () => undefined;
    const detailBase = { repoIndex: 0, worktreeIndex: 0, action };

    expect(
      resolveTreeDoubleClickAction(
        {
          type: "detail",
          ...detailBase,
          detailKind: "pr",
          label: "PR #1",
          meta: { rollupState: null },
        },
        repos,
        new Set(["repo-a/main"]),
      ),
    ).toEqual({ type: "activate-detail", action });
    expect(
      resolveTreeDoubleClickAction(
        {
          type: "detail",
          ...detailBase,
          detailKind: "pane",
          label: "0:0 bun",
          meta: {
            paneId: "%1",
            window: "0",
            paneIndex: 0,
            command: "bun",
          },
        },
        repos,
        new Set(["repo-a/main"]),
      ),
    ).toEqual({ type: "activate-detail", action });

    expect(
      resolveTreeDoubleClickAction(
        { type: "repo", repoIndex: 0 },
        repos,
        new Set(),
      ),
    ).toEqual({ type: "noop" });
    expect(
      resolveTreeDoubleClickAction(
        {
          type: "detail",
          repoIndex: 0,
          worktreeIndex: 0,
          detailKind: "pane-header",
          label: "Panes (1)",
        },
        repos,
        new Set(["repo-a/main"]),
      ),
    ).toEqual({ type: "noop" });
  });
});

describe("resolveTreeMouseTarget", () => {
  test("maps repo, worktree, and detail display rows", () => {
    const repos = [fakeRepo("repo-a", ["main"])];
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
      {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pr",
        label: "PR #1",
        meta: { rollupState: null },
      },
    ];
    const options = {
      items,
      repos,
      pendingActions: new Map<string, PendingAction>(),
      expandedWorktreeKeys: new Set(["repo-a/main"]),
    };

    expect(resolveTreeMouseTarget({ ...options, row: 0 })).toBe(0);
    expect(resolveTreeMouseTarget({ ...options, row: 1 })).toBe(1);
    expect(resolveTreeMouseTarget({ ...options, row: 2 })).toBe(1);
    expect(resolveTreeMouseTarget({ ...options, row: 3 })).toBe(2);
  });

  test("maps a worktree stats row to its owner", () => {
    const repos = [fakeRepo("repo-a", ["main"], 2)];
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];

    expect(
      resolveTreeMouseTarget({
        row: 2,
        items,
        repos,
        pendingActions: new Map(),
        expandedWorktreeKeys: new Set(["repo-a/main"]),
      }),
    ).toBe(1);
  });

  test("accounts for empty-state and phantom rows without selecting phantoms", () => {
    const repos = [fakeRepo("repo-a", ["main"]), fakeRepo("repo-b", [])];
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
      { type: "repo", repoIndex: 1 },
    ];
    const pendingActions = new Map<string, PendingAction>([
      [
        "repo-a/feature",
        { type: "opening", project: "repo-a", branch: "feature" },
      ],
    ]);
    const options = {
      items,
      repos,
      pendingActions,
      expandedWorktreeKeys: new Set<string>(),
    };

    expect(resolveTreeMouseTarget({ ...options, row: 2 })).toBeNull();
    expect(resolveTreeMouseTarget({ ...options, row: 3 })).toBe(2);
    expect(resolveTreeMouseTarget({ ...options, row: 4 })).toBe(2);
  });

  test("adds the viewport scroll offset when resolving a visible row", () => {
    const repos = [fakeRepo("repo-a", ["one", "two", "three"])];
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 1 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 2 },
    ];

    expect(
      resolveTreeMouseTarget({
        row: 0,
        scrollOffset: 2,
        items,
        repos,
        pendingActions: new Map(),
        expandedWorktreeKeys: new Set(),
      }),
    ).toBe(2);
  });
});

describe("tree viewport", () => {
  test("yields the content area to modals instead of reserving tree rows", () => {
    expect(resolveTreeViewportHeight(24, 3, false)).toBe(19);
    expect(resolveTreeViewportHeight(24, 3, true)).toBe(0);
  });

  test("allows zero tree rows when the footer consumes the terminal", () => {
    expect(resolveTreeViewportHeight(5, 3, false)).toBe(0);
    expect(resolveTreeViewportHeight(4, 3, false)).toBe(0);
  });

  test("scrolls within rendered-row bounds", () => {
    expect(scrollTreeViewport(0, 3, 10, 4)).toBe(3);
    expect(scrollTreeViewport(5, 3, 10, 4)).toBe(6);
    expect(scrollTreeViewport(2, -3, 10, 4)).toBe(0);
    expect(scrollTreeViewport(2, 3, 3, 4)).toBe(0);
  });

  test("reveals the selected item's entire rendered row range", () => {
    const rows = [0, 1, 1, 2, 3];
    expect(revealTreeItem(rows, 1, 3, 2)).toBe(1);
    expect(revealTreeItem(rows, 3, 0, 3)).toBe(2);
    expect(revealTreeItem(rows, 0, 2, 3)).toBe(0);
  });

  test("keeps an oversized item's selectable first row visible", () => {
    const rows = [0, 1, 1, 2];
    expect(revealTreeItem(rows, 1, 0, 1)).toBe(1);
    expect(revealTreeItem(rows, 1, 2, 1)).toBe(1);
  });

  test("builds rows for secondary worktree content", () => {
    const repos = [fakeRepo("repo-a", ["main"], 2)];
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    expect(
      getTreeRenderedRows({
        items,
        repos,
        pendingActions: new Map(),
        expandedWorktreeKeys: new Set(["repo-a/main"]),
      }),
    ).toEqual([0, 1, 1]);
  });

  test("counts the unknown-sync marker as a secondary worktree row", () => {
    const repos = [fakeRepo("repo-a", ["main"])];
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];

    expect(
      getTreeRenderedRows({
        items,
        repos,
        pendingActions: new Map(),
        expandedWorktreeKeys: new Set(["repo-a/main"]),
      }),
    ).toEqual([0, 1, 1]);
  });
});

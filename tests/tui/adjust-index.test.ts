import { describe, expect, test } from "vitest";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { resolveSessionHandoff } from "../../src/tui/session-utils";
import {
  adjustIndexForDetailCollapse,
  resolveCloseSelectedWorktreeAction,
  resolveExpandedRightArrowAction,
  resolveRecoveredSelectionIndex,
  resolveSelectedWorktreeIndex,
  treeItemId,
} from "../../src/tui/tree-helpers";
import { Mode, pendingKey, type TreeItem } from "../../src/tui/types";

function repo(repoIndex: number): TreeItem {
  return { type: "repo", repoIndex };
}

function worktree(repoIndex: number, worktreeIndex: number): TreeItem {
  return { type: "worktree", repoIndex, worktreeIndex };
}

function detail(
  repoIndex: number,
  worktreeIndex: number,
  kind: "pr" | "pane-header" = "pr",
): TreeItem {
  return {
    type: "detail",
    repoIndex,
    worktreeIndex,
    detailKind: kind,
    label: `detail-${kind}`,
    ...(kind === "pr" ? { meta: { rollupState: null } } : {}),
  } as TreeItem;
}

function fakeRepo(id: string, branches: string[]): RepoInfo {
  return {
    id,
    repoPath: `/tmp/${id}`,
    project: id,
    worktrees: branches.map((b) => ({
      branch: b,
      path: `/tmp/${id}/${b}`,
      isMainWorktree: false,
      changedFiles: 0,
      sync: null,
    })),
    profileNames: [],
  };
}

describe("adjustIndexForDetailCollapse", () => {
  // [0] Repo A
  // [1]   branch-1  (expanded)
  // [2]     PR #42        (detail)
  // [3]     Panes (1)     (detail)
  // [4]     pane 0:0      (detail)
  // [5]   branch-2
  // [6] Repo B
  // [7]   branch-3
  const items: TreeItem[] = [
    repo(0),
    worktree(0, 0),
    detail(0, 0, "pr"),
    detail(0, 0, "pane-header"),
    detail(0, 0, "pr"),
    worktree(0, 1),
    repo(1),
    worktree(1, 0),
  ];

  test("cursor on detail row snaps to parent worktree", () => {
    expect(adjustIndexForDetailCollapse(items, 2)).toBe(1);
    expect(adjustIndexForDetailCollapse(items, 3)).toBe(1);
    expect(adjustIndexForDetailCollapse(items, 4)).toBe(1);
  });

  test("cursor after details subtracts detail count", () => {
    // branch-2 at index 5, 3 details before → 5 - 3 = 2
    expect(adjustIndexForDetailCollapse(items, 5)).toBe(2);
    // Repo B at index 6, 3 details before → 6 - 3 = 3
    expect(adjustIndexForDetailCollapse(items, 6)).toBe(3);
    // branch-3 at index 7, 3 details before → 7 - 3 = 4
    expect(adjustIndexForDetailCollapse(items, 7)).toBe(4);
  });

  test("cursor before details stays unchanged", () => {
    expect(adjustIndexForDetailCollapse(items, 0)).toBe(0);
    expect(adjustIndexForDetailCollapse(items, 1)).toBe(1);
  });

  test("no detail rows returns same index", () => {
    const simple: TreeItem[] = [repo(0), worktree(0, 0), worktree(0, 1)];
    expect(adjustIndexForDetailCollapse(simple, 0)).toBe(0);
    expect(adjustIndexForDetailCollapse(simple, 1)).toBe(1);
    expect(adjustIndexForDetailCollapse(simple, 2)).toBe(2);
  });

  test("empty tree returns selected index unchanged", () => {
    expect(adjustIndexForDetailCollapse([], 0)).toBe(0);
  });
});

describe("treeItemId", () => {
  const repos: RepoInfo[] = [
    fakeRepo("repo-a", ["main", "feature-x"]),
    fakeRepo("repo-b", ["main"]),
  ];

  test("returns stable id for repo items", () => {
    expect(treeItemId(repo(0), repos)).toBe("repo:repo-a");
    expect(treeItemId(repo(1), repos)).toBe("repo:repo-b");
  });

  test("returns stable id for worktree items", () => {
    expect(treeItemId(worktree(0, 0), repos)).toBe("wt:repo-a/main");
    expect(treeItemId(worktree(0, 1), repos)).toBe("wt:repo-a/feature-x");
    expect(treeItemId(worktree(1, 0), repos)).toBe("wt:repo-b/main");
  });

  test("returns stable id for detail items", () => {
    expect(treeItemId(detail(0, 0, "pr"), repos)).toBe("detail:repo-a/main/pr");
  });

  test("pr detail id is stable", () => {
    const prItem = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pr",
      label: "PR #42",
      meta: { rollupState: null },
    } as TreeItem;
    expect(treeItemId(prItem, repos)).toBe("detail:repo-a/main/pr");
  });

  test("pane details include paneId for uniqueness", () => {
    const paneA = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane",
      label: "main:0 bash",
      meta: {
        paneId: "%1",
        zoomed: false,
        active: false,
        window: "main",
        paneIndex: 0,
        command: "bash",
      },
    } as TreeItem;
    const paneB = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane",
      label: "main:1 bash",
      meta: {
        paneId: "%2",
        zoomed: false,
        active: true,
        window: "main",
        paneIndex: 1,
        command: "bash",
      },
    } as TreeItem;
    expect(treeItemId(paneA, repos)).toBe("detail:repo-a/main/pane/%1");
    expect(treeItemId(paneB, repos)).toBe("detail:repo-a/main/pane/%2");
    expect(treeItemId(paneA, repos)).not.toBe(treeItemId(paneB, repos));
  });

  test("returns null for out-of-range repo index", () => {
    expect(treeItemId(repo(99), repos)).toBeNull();
  });

  test("returns null for out-of-range worktree index", () => {
    expect(treeItemId(worktree(0, 99), repos)).toBeNull();
  });

  test("identity is independent of positional index in tree", () => {
    // Same worktree at different tree positions should produce the same id
    const item = worktree(0, 1);
    expect(treeItemId(item, repos)).toBe(treeItemId(item, repos));
  });
});

describe("identity-based recovery scenarios", () => {
  // Simulate background refresh removing a worktree before the selected one
  test("selected item shifts when earlier worktree is removed", () => {
    const reposBefore: RepoInfo[] = [
      fakeRepo("repo-a", ["main", "feat-1", "feat-2"]),
    ];
    const itemsBefore: TreeItem[] = [
      repo(0),
      worktree(0, 0), // main
      worktree(0, 1), // feat-1
      worktree(0, 2), // feat-2  ← selected at index 3
    ];

    const selectedIndex = 3;
    const selectedItem = itemsBefore[selectedIndex];
    if (!selectedItem) {
      throw new Error("expected selected worktree item");
    }
    const selectedId = treeItemId(selectedItem, reposBefore);
    expect(selectedId).toBe("wt:repo-a/feat-2");

    // After refresh: feat-1 removed, feat-2 is now at worktreeIndex 1
    const reposAfter: RepoInfo[] = [fakeRepo("repo-a", ["main", "feat-2"])];
    const itemsAfter: TreeItem[] = [
      repo(0),
      worktree(0, 0), // main
      worktree(0, 1), // feat-2  ← now at index 2
    ];

    // Old selectedIndex (3) is out of bounds — find by identity
    const recovered = itemsAfter.findIndex(
      (item) => treeItemId(item, reposAfter) === selectedId,
    );
    expect(recovered).toBe(2);
  });

  test("selected item gone returns -1 from identity search", () => {
    const reposBefore: RepoInfo[] = [fakeRepo("repo-a", ["main", "feat-1"])];
    const selectedId = treeItemId(worktree(0, 1), reposBefore);
    expect(selectedId).toBe("wt:repo-a/feat-1");

    // After refresh: feat-1 deleted entirely
    const reposAfter: RepoInfo[] = [fakeRepo("repo-a", ["main"])];
    const itemsAfter: TreeItem[] = [repo(0), worktree(0, 0)];

    const recovered = itemsAfter.findIndex(
      (item) => treeItemId(item, reposAfter) === selectedId,
    );
    expect(recovered).toBe(-1);
  });

  test("recovery with multiple panes targets the correct one", () => {
    const repos: RepoInfo[] = [fakeRepo("repo-a", ["main"])];
    const pane1 = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane",
      label: "main:0 bash",
      meta: {
        paneId: "%1",
        zoomed: false,
        active: false,
        window: "main",
        paneIndex: 0,
        command: "bash",
      },
    } as TreeItem;
    const pane2 = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane",
      label: "main:1 vim",
      meta: {
        paneId: "%2",
        zoomed: false,
        active: true,
        window: "main",
        paneIndex: 1,
        command: "vim",
      },
    } as TreeItem;

    const itemsBefore: TreeItem[] = [
      repo(0),
      worktree(0, 0),
      pane1, // index 2
      pane2, // index 3  ← selected
    ];

    // User selected pane2 (%2)
    const selectedItem = itemsBefore[3];
    if (!selectedItem) {
      throw new Error("expected selected pane item");
    }
    const selectedId = treeItemId(selectedItem, repos);
    expect(selectedId).toBe("detail:repo-a/main/pane/%2");

    // After refresh: panes reordered (pane2 now comes first)
    const itemsAfter: TreeItem[] = [
      repo(0),
      worktree(0, 0),
      pane2, // index 2
      pane1, // index 3
    ];

    const recovered = itemsAfter.findIndex(
      (item) => treeItemId(item, repos) === selectedId,
    );
    // Should find pane2 at its new position, not pane1
    expect(recovered).toBe(2);
  });
});

describe("resolveRecoveredSelectionIndex", () => {
  test("skips identity recovery when search query just changed", () => {
    const repos: RepoInfo[] = [
      fakeRepo("repo-a", ["main", "feat-1", "feat-2"]),
    ];
    const prevTree: TreeItem[] = [
      repo(0),
      worktree(0, 0),
      worktree(0, 1),
      worktree(0, 2),
    ];
    const nextTree: TreeItem[] = [repo(0), worktree(0, 1), worktree(0, 2)];

    expect(
      resolveRecoveredSelectionIndex({
        prevTree,
        treeItems: nextTree,
        prevSelectionId: "wt:repo-a/feat-2",
        selectedIndex: 2,
        repos,
        skipIdentityRecovery: true,
      }),
    ).toBeNull();
  });
});

describe("resolveSelectedWorktreeIndex", () => {
  test("returns the same index for a selected worktree row", () => {
    const items: TreeItem[] = [repo(0), worktree(0, 0)];
    expect(resolveSelectedWorktreeIndex(items, 1)).toBe(1);
  });

  test("returns the parent worktree index for a selected detail row", () => {
    const items: TreeItem[] = [repo(0), worktree(0, 0), detail(0, 0, "pr")];
    expect(resolveSelectedWorktreeIndex(items, 2)).toBe(1);
  });

  test("returns null for a selected repo row", () => {
    const items: TreeItem[] = [repo(0), worktree(0, 0)];
    expect(resolveSelectedWorktreeIndex(items, 0)).toBeNull();
  });
});

describe("resolveCloseSelectedWorktreeAction", () => {
  test("exits expanded mode when closing the active expanded worktree", () => {
    const repos: RepoInfo[] = [fakeRepo("repo-a", ["main", "feat-1"])];
    const items: TreeItem[] = [
      repo(0),
      worktree(0, 0),
      detail(0, 0, "pr"),
      worktree(0, 1),
    ];

    expect(
      resolveCloseSelectedWorktreeAction({
        mode: Mode.Expanded(pendingKey("repo-a", "main")),
        repos,
        items,
        selectedIndex: 2,
      }),
    ).toEqual({
      type: "close-worktree",
      worktreeIndex: 1,
      worktreeKey: "repo-a/main",
      nextMode: Mode.Navigate,
      nextSelectedIndex: 1,
    });
  });
});

describe("resolveExpandedRightArrowAction", () => {
  test("expands a collapsed repo while another repo's worktree is expanded", () => {
    const repos: RepoInfo[] = [
      fakeRepo("repo-a", ["main"]),
      fakeRepo("repo-b", ["feature-b"]),
    ];
    const items: TreeItem[] = [
      repo(0),
      worktree(0, 0),
      detail(0, 0, "pr"),
      repo(1),
    ];

    expect(
      resolveExpandedRightArrowAction({
        repos,
        items,
        selectedIndex: 3,
        expandedRepos: new Set(["repo-a"]),
      }),
    ).toEqual({
      type: "expand-repo",
      repoId: "repo-b",
    });
  });

  test("switches the expanded worktree using the collapsed tree index", () => {
    const repos: RepoInfo[] = [fakeRepo("repo-a", ["main", "feature-b"])];
    const items: TreeItem[] = [
      repo(0),
      worktree(0, 0),
      detail(0, 0, "pr"),
      detail(0, 0, "pane-header"),
      worktree(0, 1),
    ];

    expect(
      resolveExpandedRightArrowAction({
        repos,
        items,
        selectedIndex: 4,
        expandedRepos: new Set(["repo-a"]),
      }),
    ).toEqual({
      type: "expand-worktree",
      nextMode: Mode.Expanded(pendingKey("repo-a", "feature-b")),
      nextSelectedIndex: 2,
    });
  });
});

describe("resolveSessionHandoff", () => {
  test("returns a switch plan when the active client is on the target", () => {
    expect(
      resolveSessionHandoff({
        client: {
          type: "single",
          client: { tty: "/dev/ttys001", session: "feature-a" },
        },
        targetSession: "feature-a",
        sessions: [{ name: "feature-a" }, { name: "main" }],
      }),
    ).toEqual({
      type: "switch",
      sessionName: "main",
    });
  });

  test("returns a no-op plan when the active client is on a different session", () => {
    expect(
      resolveSessionHandoff({
        client: {
          type: "single",
          client: { tty: "/dev/ttys001", session: "main" },
        },
        targetSession: "feature-a",
        sessions: [{ name: "feature-a" }, { name: "main" }],
      }),
    ).toEqual({ type: "not-needed" });
  });

  test("returns a no-op plan when there is no active client", () => {
    expect(
      resolveSessionHandoff({
        client: { type: "none" },
        targetSession: "feature-a",
        sessions: [{ name: "feature-a" }, { name: "main" }],
      }),
    ).toEqual({ type: "not-needed" });
  });

  test("returns a detach plan when there is no alternate session to switch to", () => {
    expect(
      resolveSessionHandoff({
        client: {
          type: "single",
          client: { tty: "/dev/ttys001", session: "feature-a" },
        },
        targetSession: "feature-a",
        sessions: [{ name: "feature-a" }],
      }),
    ).toEqual({ type: "detach" });
  });

  test("returns a blocked plan when multiple tmux clients are attached", () => {
    expect(
      resolveSessionHandoff({
        client: { type: "multiple" },
        targetSession: "feature-a",
        sessions: [{ name: "feature-a" }, { name: "main" }],
      }),
    ).toEqual({ type: "blocked" });
  });

  test("returns a blocked plan when client discovery fails", () => {
    expect(
      resolveSessionHandoff({
        client: { type: "error" },
        targetSession: "feature-a",
        sessions: [{ name: "feature-a" }, { name: "main" }],
      }),
    ).toEqual({ type: "blocked" });
  });
});

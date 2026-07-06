import { describe, expect, test } from "vitest";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { wrapPrLabel } from "../../src/tui/pr-layout";
import {
  buildTreeItems,
  buildTreeRows,
  clampScrollOffset,
  isWithinExpandedSubtree,
  scrollToKeepVisible,
} from "../../src/tui/tree-helpers";
import { type PendingAction, pendingKey } from "../../src/tui/types";

function repo(overrides: Partial<RepoInfo> & { id: string }): RepoInfo {
  return {
    id: overrides.id,
    repoPath: overrides.repoPath ?? `/tmp/${overrides.id}`,
    project: overrides.project ?? overrides.id,
    worktrees: overrides.worktrees ?? [],
    profileNames: overrides.profileNames ?? [],
    ideDefaults: overrides.ideDefaults ?? { baseNoIde: true, profileNoIde: {} },
  };
}

const emptyOpts = {
  prData: new Map(),
  panes: new Map(),
  jumpToPane: () => undefined,
};

describe("buildTreeRows", () => {
  test("a collapsed repo with one worktree maps each row 1:1 to its item", () => {
    const repos = [
      repo({
        id: "repo-1",
        project: "alpha",
        worktrees: [
          {
            branch: "main",
            path: "/tmp/alpha-main",
            isMainWorktree: true,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
        ],
      }),
    ];
    const expandedRepos = new Set(["repo-1"]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      pendingActions: new Map(),
    });

    // items: [repo, worktree]; sync is clean so no stats row even if expanded.
    expect(rows.map((r) => r.itemIndex)).toEqual([0, 1]);
    expect(rows.map((r) => r.kind)).toEqual(["repo", "worktree"]);
  });

  test("an expanded worktree with stats inserts a null-mapped stats row", () => {
    const branch = "feature/x";
    const repos = [
      repo({
        id: "repo-1",
        project: "alpha",
        worktrees: [
          {
            branch,
            path: "/tmp/alpha-x",
            isMainWorktree: false,
            changedFiles: 3,
            sync: { ahead: 1, behind: 0 },
          },
        ],
      }),
    ];
    const expandedRepos = new Set(["repo-1"]);
    const expandedWorktreeKey = pendingKey("alpha", branch);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey,
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey,
      pendingActions: new Map(),
    });

    // items: [repo(0), worktree(1)]
    expect(rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }))).toEqual(
      [
        { itemIndex: 0, kind: "repo" },
        { itemIndex: 1, kind: "worktree" },
        { itemIndex: null, kind: "worktree-stats" },
      ],
    );
  });

  test("a clean expanded worktree does NOT insert a stats row", () => {
    const branch = "feature/clean";
    const repos = [
      repo({
        id: "repo-1",
        project: "alpha",
        worktrees: [
          {
            branch,
            path: "/tmp/alpha-clean",
            isMainWorktree: false,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
        ],
      }),
    ];
    const expandedRepos = new Set(["repo-1"]);
    const expandedWorktreeKey = pendingKey("alpha", branch);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey,
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey,
      pendingActions: new Map(),
    });

    expect(rows.map((r) => r.kind)).toEqual(["repo", "worktree"]);
  });

  test("an expanded repo with no worktrees emits a (no worktrees) row", () => {
    const repos = [repo({ id: "repo-1", project: "empty", worktrees: [] })];
    const expandedRepos = new Set(["repo-1"]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      pendingActions: new Map(),
    });

    expect(rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }))).toEqual(
      [
        { itemIndex: 0, kind: "repo" },
        { itemIndex: null, kind: "repo-empty" },
      ],
    );
  });

  test("a collapsed repo with no worktrees does NOT emit a (no worktrees) row", () => {
    const repos = [repo({ id: "repo-1", project: "empty", worktrees: [] })];
    const expandedRepos = new Set<string>();
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      pendingActions: new Map(),
    });

    expect(rows.map((r) => r.kind)).toEqual(["repo"]);
  });

  test("phantom opening rows for a populated repo follow its worktree block", () => {
    const repos = [
      repo({
        id: "repo-1",
        project: "alpha",
        worktrees: [
          {
            branch: "main",
            path: "/tmp/alpha-main",
            isMainWorktree: true,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
        ],
      }),
    ];
    const expandedRepos = new Set(["repo-1"]);
    const pendingActions = new Map<string, PendingAction>([
      [
        pendingKey("alpha", "feature/new"),
        { type: "opening", branch: "feature/new", project: "alpha" },
      ],
    ]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      pendingActions,
    });

    expect(rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }))).toEqual(
      [
        { itemIndex: 0, kind: "repo" },
        { itemIndex: 1, kind: "worktree" },
        { itemIndex: null, kind: "phantom" },
      ],
    );
  });

  test("phantom rows still follow the last worktree when it is expanded with trailing detail rows", () => {
    const branch = "feature/pr";
    const repos = [
      repo({
        id: "repo-1",
        project: "alpha",
        worktrees: [
          {
            branch: "main",
            path: "/tmp/alpha-main",
            isMainWorktree: true,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
          {
            branch,
            path: "/tmp/alpha-pr",
            isMainWorktree: false,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
        ],
      }),
    ];
    const expandedRepos = new Set(["repo-1"]);
    const expandedWorktreeKey = pendingKey("alpha", branch);
    const prData = new Map([
      [
        expandedWorktreeKey,
        {
          number: 1,
          title: "Add thing",
          state: "OPEN" as const,
          headRefName: branch,
          rollupState: "success" as const,
        },
      ],
    ]);
    const pendingActions = new Map<string, PendingAction>([
      [
        pendingKey("alpha", "feature/new"),
        { type: "opening", branch: "feature/new", project: "alpha" },
      ],
    ]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey,
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey,
      pendingActions,
    });

    // items: [repo(0), wt main(1), wt feature/pr(2), pr-detail(3)]. The
    // phantom must come AFTER the expanded last worktree's detail rows — a
    // next-item-only "last worktree" check would drop it entirely.
    expect(rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }))).toEqual(
      [
        { itemIndex: 0, kind: "repo" },
        { itemIndex: 1, kind: "worktree" },
        { itemIndex: 2, kind: "worktree" },
        { itemIndex: 3, kind: "detail" },
        { itemIndex: null, kind: "phantom" },
      ],
    );
  });

  test("phantom rows follow the LAST worktree when an earlier worktree is expanded with detail rows", () => {
    const branch = "feature/pr";
    const repos = [
      repo({
        id: "repo-1",
        project: "alpha",
        worktrees: [
          {
            branch,
            path: "/tmp/alpha-pr",
            isMainWorktree: false,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
          {
            branch: "main",
            path: "/tmp/alpha-main",
            isMainWorktree: true,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
        ],
      }),
    ];
    const expandedRepos = new Set(["repo-1"]);
    const expandedWorktreeKey = pendingKey("alpha", branch);
    const prData = new Map([
      [
        expandedWorktreeKey,
        {
          number: 1,
          title: "Add thing",
          state: "OPEN" as const,
          headRefName: branch,
          rollupState: "success" as const,
        },
      ],
    ]);
    const pendingActions = new Map<string, PendingAction>([
      [
        pendingKey("alpha", "feature/new"),
        { type: "opening", branch: "feature/new", project: "alpha" },
      ],
    ]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey,
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey,
      pendingActions,
    });

    // items: [repo(0), wt feature/pr(1), pr-detail(2), wt main(3)]. Detail
    // rows in the MIDDLE of the repo block must not trigger phantom emission;
    // the phantom still trails the final worktree.
    expect(rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }))).toEqual(
      [
        { itemIndex: 0, kind: "repo" },
        { itemIndex: 1, kind: "worktree" },
        { itemIndex: 2, kind: "detail" },
        { itemIndex: 3, kind: "worktree" },
        { itemIndex: null, kind: "phantom" },
      ],
    );
  });

  test("phantom rows for an empty expanded repo are appended at the bottom of the whole tree", () => {
    const repos = [
      repo({
        id: "repo-1",
        project: "alpha",
        worktrees: [
          {
            branch: "main",
            path: "/tmp/alpha-main",
            isMainWorktree: true,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
        ],
      }),
      repo({ id: "repo-2", project: "empty", worktrees: [] }),
    ];
    const expandedRepos = new Set(["repo-1", "repo-2"]);
    const pendingActions = new Map<string, PendingAction>([
      [
        pendingKey("empty", "feature/seed"),
        { type: "opening", branch: "feature/seed", project: "empty" },
      ],
    ]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      pendingActions,
    });

    // items: [repo-1(0), worktree(1), repo-2(2)]
    // The empty-repo phantom is NOT placed under repo-2; it is appended last.
    expect(rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }))).toEqual(
      [
        { itemIndex: 0, kind: "repo" },
        { itemIndex: 1, kind: "worktree" },
        { itemIndex: 2, kind: "repo" },
        { itemIndex: null, kind: "repo-empty" },
        { itemIndex: null, kind: "phantom" },
      ],
    );
  });

  test("detail rows under an expanded worktree map 1:1 to their items", () => {
    const branch = "feature/pr";
    const repos = [
      repo({
        id: "repo-1",
        project: "alpha",
        worktrees: [
          {
            branch,
            path: "/tmp/alpha-pr",
            isMainWorktree: false,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
        ],
      }),
    ];
    const expandedRepos = new Set(["repo-1"]);
    const expandedWorktreeKey = pendingKey("alpha", branch);
    const prData = new Map([
      [
        expandedWorktreeKey,
        {
          number: 1,
          title: "Add thing",
          state: "OPEN" as const,
          headRefName: branch,
          rollupState: "success" as const,
        },
      ],
    ]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey,
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey,
      pendingActions: new Map(),
    });

    // items: [repo(0), worktree(1), pr-detail(2)]; clean sync → no stats row.
    expect(rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }))).toEqual(
      [
        { itemIndex: 0, kind: "repo" },
        { itemIndex: 1, kind: "worktree" },
        { itemIndex: 2, kind: "detail" },
      ],
    );
  });

  test("a PR label that wraps emits continuation rows so rows below stay aligned", () => {
    const branch = "feature/pr";
    const repos = [
      repo({
        id: "repo-1",
        project: "alpha",
        worktrees: [
          {
            branch,
            path: "/tmp/alpha-pr",
            isMainWorktree: false,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
          {
            branch: "main",
            path: "/tmp/alpha-main",
            isMainWorktree: true,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
        ],
      }),
    ];
    const expandedRepos = new Set(["repo-1"]);
    const expandedWorktreeKey = pendingKey("alpha", branch);
    const prData = new Map([
      [
        expandedWorktreeKey,
        {
          number: 1,
          title: "a very long pull request title that certainly wraps",
          state: "OPEN" as const,
          headRefName: branch,
          rollupState: "success" as const,
        },
      ],
    ]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey,
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey,
      pendingActions: new Map(),
      maxWidth: 40,
    });

    // items: [repo(0), wt feature/pr(1), pr-detail(2), wt main(3)].
    // The PR line wraps at width 40, so the row model inserts continuation
    // row(s) — all carrying the PR's own itemIndex (2) — before the next
    // worktree row (item 3), which must remain a distinct terminal row.
    const shape = rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }));
    expect(shape[0]).toEqual({ itemIndex: 0, kind: "repo" });
    expect(shape[1]).toEqual({ itemIndex: 1, kind: "worktree" });
    expect(shape[2]).toEqual({ itemIndex: 2, kind: "detail" });

    const contRows = shape.filter((r) => r.kind === "detail-pr-cont");
    expect(contRows.length).toBeGreaterThan(0);
    expect(contRows.every((r) => r.itemIndex === 2)).toBe(true);

    // The following worktree is still its own row, right after the PR block.
    expect(shape[3 + contRows.length]).toEqual({
      itemIndex: 3,
      kind: "worktree",
    });

    // Every PR row carries its own wrapped line text so the render consumes
    // exactly the lines this model counted (DetailRow never re-wraps): the
    // detail row holds line 0 and each continuation row holds its piece.
    const prItem = items[2];
    if (prItem?.type !== "detail") throw new Error("expected detail item");
    const expectedLines = wrapPrLabel(prItem.label, 40, true);
    const prRows = rows.filter(
      (r) => r.kind === "detail" || r.kind === "detail-pr-cont",
    );
    expect(prRows.map((r) => r.prLine)).toEqual(expectedLines);
  });

  test("a PR label that fits on one line emits no continuation rows", () => {
    const branch = "feature/pr";
    const repos = [
      repo({
        id: "repo-1",
        project: "alpha",
        worktrees: [
          {
            branch,
            path: "/tmp/alpha-pr",
            isMainWorktree: false,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
        ],
      }),
    ];
    const expandedRepos = new Set(["repo-1"]);
    const expandedWorktreeKey = pendingKey("alpha", branch);
    const prData = new Map([
      [
        expandedWorktreeKey,
        {
          number: 1,
          title: "short",
          state: "OPEN" as const,
          headRefName: branch,
          rollupState: "success" as const,
        },
      ],
    ]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey,
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey,
      pendingActions: new Map(),
      maxWidth: 80,
    });

    expect(rows.map((r) => r.kind)).toEqual(["repo", "worktree", "detail"]);
  });

  test("a PR with no rollup icon still emits continuation rows when it wraps", () => {
    const branch = "feature/pr";
    const repos = [
      repo({
        id: "repo-1",
        project: "alpha",
        worktrees: [
          {
            branch,
            path: "/tmp/alpha-pr",
            isMainWorktree: false,
            changedFiles: 0,
            sync: { ahead: 0, behind: 0 },
          },
        ],
      }),
    ];
    const expandedRepos = new Set(["repo-1"]);
    const expandedWorktreeKey = pendingKey("alpha", branch);
    const prData = new Map([
      [
        expandedWorktreeKey,
        {
          number: 1,
          title: "a very long pull request title that certainly wraps",
          state: "OPEN" as const,
          headRefName: branch,
          // No rollup icon → wrap budget uses prLabelStart(false), a different
          // code path than the icon case.
          rollupState: null,
        },
      ],
    ]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey,
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey,
      pendingActions: new Map(),
      maxWidth: 40,
    });

    const contRows = rows.filter((r) => r.kind === "detail-pr-cont");
    expect(contRows.length).toBeGreaterThan(0);
    expect(contRows.every((r) => r.itemIndex === 2)).toBe(true);
  });
});

describe("clampScrollOffset", () => {
  test("clamps below zero to zero", () => {
    expect(clampScrollOffset(-5, 10, 4)).toBe(0);
  });

  test("clamps above the max scrollable offset", () => {
    // max = rowsLength - viewportRows = 10 - 4 = 6
    expect(clampScrollOffset(99, 10, 4)).toBe(6);
  });

  test("leaves an in-range offset untouched", () => {
    expect(clampScrollOffset(3, 10, 4)).toBe(3);
  });

  test("forces 0 when the tree fits the viewport", () => {
    expect(clampScrollOffset(2, 4, 10)).toBe(0);
    expect(clampScrollOffset(2, 10, 10)).toBe(0);
  });
});

describe("scrollToKeepVisible", () => {
  test("leaves the offset unchanged when the row is already inside the window", () => {
    // window covers rows [2..6]
    expect(scrollToKeepVisible(4, 2, 5)).toBe(2);
    expect(scrollToKeepVisible(2, 2, 5)).toBe(2); // top edge
    expect(scrollToKeepVisible(6, 2, 5)).toBe(2); // bottom edge
  });

  test("scrolls up by exactly the gap when the row is just above the window", () => {
    // window [5..9]; selecting row 4 nudges offset to 4 (gap of 1)
    expect(scrollToKeepVisible(4, 5, 5)).toBe(4);
    // selecting row 1 nudges offset to 1
    expect(scrollToKeepVisible(1, 5, 5)).toBe(1);
  });

  test("scrolls down minimally when the row is just below the window", () => {
    // window [0..4]; selecting row 5 → offset = 5 - 5 + 1 = 1
    expect(scrollToKeepVisible(5, 0, 5)).toBe(1);
    // selecting row 7 → offset = 7 - 5 + 1 = 3
    expect(scrollToKeepVisible(7, 0, 5)).toBe(3);
  });

  test("returns the offset unchanged for a zero/negative viewport", () => {
    expect(scrollToKeepVisible(3, 2, 0)).toBe(2);
  });
});

describe("isWithinExpandedSubtree", () => {
  const repos = [
    repo({
      id: "repo-1",
      project: "alpha",
      worktrees: [
        {
          branch: "feature/a",
          path: "/tmp/a",
          isMainWorktree: false,
          changedFiles: 0,
          sync: null,
        },
        {
          branch: "feature/b",
          path: "/tmp/b",
          isMainWorktree: false,
          changedFiles: 0,
          sync: null,
        },
      ],
    }),
    repo({
      id: "repo-2",
      project: "beta",
      worktrees: [
        {
          branch: "feature/c",
          path: "/tmp/c",
          isMainWorktree: false,
          changedFiles: 0,
          sync: null,
        },
      ],
    }),
  ];
  const expandedKey = pendingKey("alpha", "feature/a");
  // items: 0 repo-1, 1 wt feature/a, 2 detail(a), 3 wt feature/b,
  //        4 repo-2, 5 wt feature/c
  const items = [
    { type: "repo" as const, repoIndex: 0 },
    { type: "worktree" as const, repoIndex: 0, worktreeIndex: 0 },
    {
      type: "detail" as const,
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pr" as const,
      label: "PR #1",
      meta: { rollupState: "success" as const },
    },
    { type: "worktree" as const, repoIndex: 0, worktreeIndex: 1 },
    { type: "repo" as const, repoIndex: 1 },
    { type: "worktree" as const, repoIndex: 1, worktreeIndex: 0 },
  ];

  test("a detail row owned by the expanded worktree is within the subtree", () => {
    expect(isWithinExpandedSubtree(items, 2, expandedKey, repos)).toBe(true);
  });

  test("the expanded worktree row itself is within the subtree", () => {
    expect(isWithinExpandedSubtree(items, 1, expandedKey, repos)).toBe(true);
  });

  test("a sibling worktree in the same repo is NOT within the subtree", () => {
    expect(isWithinExpandedSubtree(items, 3, expandedKey, repos)).toBe(false);
  });

  test("a worktree in another repo is NOT within the subtree", () => {
    expect(isWithinExpandedSubtree(items, 5, expandedKey, repos)).toBe(false);
  });

  test("a repo row resolves to no owning worktree and is not within", () => {
    expect(isWithinExpandedSubtree(items, 0, expandedKey, repos)).toBe(false);
  });

  test("returns false when no worktree is expanded", () => {
    expect(isWithinExpandedSubtree(items, 1, null, repos)).toBe(false);
  });
});

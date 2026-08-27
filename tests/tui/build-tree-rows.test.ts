import { describe, expect, test } from "vitest";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import {
  HEADER_OFFSET,
  resolveHoverItemIndex,
  resolveMouseAction,
} from "../../src/tui/input/mouse";
import {
  type LifecycleEntry,
  type LifecyclePhase,
  type LifecycleState,
  lifecycleKey,
  lifecyclePhaseLabel,
} from "../../src/tui/lifecycle";
import { wrapPrLabel } from "../../src/tui/pr-layout";
import {
  buildTreeItems,
  buildTreeRows,
  clampScrollOffset,
  confirmationRowRange,
  firstRowForItem,
  insertConfirmationRows,
  resolveConfirmationAnchorItemIndex,
  scrollRangeToKeepVisible,
  scrollToKeepVisible,
} from "../../src/tui/tree-helpers";
import { Mode, pendingKey } from "../../src/tui/types";

function openLifecycle(
  repoPath: string,
  project: string,
  branch: string,
  phase: LifecyclePhase = { _tag: "Preparing" },
): LifecycleState {
  const entry: LifecycleEntry = {
    operation: "open",
    repoPath,
    project,
    branch,
    phase,
  };
  return new Map([[lifecycleKey(repoPath, branch), entry]]);
}

function repo(overrides: Partial<RepoInfo> & { id: string }): RepoInfo {
  return {
    id: overrides.id,
    repoPath: overrides.repoPath ?? `/tmp/${overrides.id}`,
    project: overrides.project ?? overrides.id,
    worktrees: overrides.worktrees ?? [],
    profileNames: overrides.profileNames ?? [],
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
      expandedWorktreeKeys: new Set<string>(),
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set<string>(),
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
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
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
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
    });

    expect(rows.map((r) => r.kind)).toEqual(["repo", "worktree"]);
  });

  test("an expanded repo with no worktrees emits a (no worktrees) row", () => {
    const repos = [repo({ id: "repo-1", project: "empty", worktrees: [] })];
    const expandedRepos = new Set(["repo-1"]);
    const items = buildTreeItems({
      repos,
      expandedWorktreeKeys: new Set<string>(),
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set<string>(),
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
      expandedWorktreeKeys: new Set<string>(),
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set<string>(),
    });

    expect(rows.map((r) => r.kind)).toEqual(["repo"]);
  });

  test("pending-workspace rows for a populated repo follow its worktree block", () => {
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
    const lifecycle = openLifecycle("/tmp/repo-1", "alpha", "feature/new");
    const items = buildTreeItems({
      repos,
      expandedWorktreeKeys: new Set<string>(),
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set<string>(),
      lifecycle,
    });

    expect(rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }))).toEqual(
      [
        { itemIndex: 0, kind: "repo" },
        { itemIndex: 1, kind: "worktree" },
        { itemIndex: null, kind: "pending-workspace" },
        { itemIndex: null, kind: "lifecycle-progress" },
      ],
    );
  });

  test("pending-workspace rows still follow the last worktree when it is expanded with trailing detail rows", () => {
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
    const lifecycle = openLifecycle("/tmp/repo-1", "alpha", "feature/new");
    const items = buildTreeItems({
      repos,
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
      lifecycle,
    });

    // A next-item-only "last worktree" check would drop the pending workspace here.
    expect(rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }))).toEqual(
      [
        { itemIndex: 0, kind: "repo" },
        { itemIndex: 1, kind: "worktree" },
        { itemIndex: 2, kind: "worktree" },
        { itemIndex: 3, kind: "detail" },
        { itemIndex: null, kind: "pending-workspace" },
        { itemIndex: null, kind: "lifecycle-progress" },
      ],
    );
  });

  test("pending-workspace rows follow the LAST worktree when an earlier worktree is expanded with detail rows", () => {
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
    const lifecycle = openLifecycle("/tmp/repo-1", "alpha", "feature/new");
    const items = buildTreeItems({
      repos,
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
      lifecycle,
    });

    // Detail rows mid-block must not trigger pending emission; it still trails the final worktree.
    expect(rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }))).toEqual(
      [
        { itemIndex: 0, kind: "repo" },
        { itemIndex: 1, kind: "worktree" },
        { itemIndex: 2, kind: "detail" },
        { itemIndex: 3, kind: "worktree" },
        { itemIndex: null, kind: "pending-workspace" },
        { itemIndex: null, kind: "lifecycle-progress" },
      ],
    );
  });

  test("pending-workspace rows for an empty expanded repo are appended at the bottom of the whole tree", () => {
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
    const lifecycle = openLifecycle("/tmp/repo-2", "empty", "feature/seed");
    const items = buildTreeItems({
      repos,
      expandedWorktreeKeys: new Set<string>(),
      ...emptyOpts,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set<string>(),
      lifecycle,
    });

    // The empty repo's pending rows aren't placed under repo-2; appended last.
    expect(rows.map((r) => ({ itemIndex: r.itemIndex, kind: r.kind }))).toEqual(
      [
        { itemIndex: 0, kind: "repo" },
        { itemIndex: 1, kind: "worktree" },
        { itemIndex: 2, kind: "repo" },
        { itemIndex: null, kind: "repo-empty" },
        { itemIndex: null, kind: "pending-workspace" },
        { itemIndex: null, kind: "lifecycle-progress" },
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
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
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
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
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
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
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
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set([expandedWorktreeKey]),
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

describe("anchored confirmation rows", () => {
  const repos = [
    repo({
      id: "repo-1",
      project: "alpha",
      worktrees: [
        {
          branch: "feature/x",
          path: "/tmp/alpha-x",
          isMainWorktree: false,
          changedFiles: 0,
          sync: { ahead: 0, behind: 0 },
        },
      ],
    }),
  ];
  const items = buildTreeItems({
    repos,
    expandedWorktreeKeys: new Set<string>(),
    ...emptyOpts,
  });

  test("inserts the modal immediately below its worktree", () => {
    const baseRows = buildTreeRows({
      items,
      repos,
    });
    const mode = Mode.ConfirmClose(
      "alpha-x",
      "feature/x",
      "/tmp/alpha-x",
      "alpha/feature/x",
      "/tmp/alpha",
      "alpha",
      0,
    );
    const anchor = resolveConfirmationAnchorItemIndex(mode, items, repos);
    expect(anchor).toBe(1);

    const rows = insertConfirmationRows(baseRows, anchor ?? -1, 5);
    expect(rows.map((row) => row.kind)).toEqual([
      "repo",
      "worktree",
      "confirmation",
      "confirmation",
      "confirmation",
      "confirmation",
      "confirmation",
    ]);
    expect(confirmationRowRange(rows)).toEqual({ start: 2, end: 6 });
  });

  test("scrolls the entire modal into a viewport when it opens below it", () => {
    expect(scrollRangeToKeepVisible({ start: 12, end: 16 }, 0, 8)).toBe(9);
  });
});

describe("lifecycle rows", () => {
  const repoPath = "/tmp/repo-1";

  function repoWithWorktree(branch: string): RepoInfo[] {
    return [
      repo({
        id: "repo-1",
        project: "alpha",
        repoPath,
        worktrees: [
          {
            branch,
            path: "/tmp/alpha-x",
            isMainWorktree: false,
            changedFiles: 4,
            sync: { ahead: 2, behind: 0 },
          },
        ],
      }),
    ];
  }

  function rowsFor(repos: RepoInfo[], lifecycle: LifecycleState) {
    const items = buildTreeItems({
      repos,
      expandedWorktreeKeys: new Set<string>(),
      lifecycle,
      prData: new Map(),
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    return {
      items,
      rows: buildTreeRows({
        items,
        repos,
        expandedRepos: new Set(["repo-1"]),
        expandedWorktreeKeys: new Set<string>(),
        lifecycle,
        maxWidth: 80,
      }),
    };
  }

  test("each phase replaces the single progress row with its canonical label", () => {
    const branch = "feature/x";
    const repos = repoWithWorktree(branch);
    const phases: LifecyclePhase[] = [
      { _tag: "CreatingWorktree" },
      { _tag: "CopyingFiles" },
      { _tag: "RunningSetup", name: "install" },
      { _tag: "CreatingTmuxSession" },
    ];

    const seen: string[] = [];
    for (const phase of phases) {
      const { rows } = rowsFor(
        repos,
        openLifecycle(repoPath, "alpha", branch, phase),
      );
      const progressRows = rows.filter(
        (row) => row.kind === "lifecycle-progress",
      );
      expect(progressRows).toHaveLength(1);
      const progressRow = progressRows[0];
      if (progressRow?.kind !== "lifecycle-progress") {
        throw new Error("expected a lifecycle-progress row");
      }
      expect(progressRow.branch).toBe(branch);
      expect(progressRow.phase).toEqual(phase);
      seen.push(lifecyclePhaseLabel(progressRow.phase));
    }

    expect(seen).toEqual([
      "Creating worktree…",
      "Copying files…",
      "Setup: install…",
      "Creating tmux session…",
    ]);

    const { rows } = rowsFor(
      repos,
      openLifecycle(repoPath, "alpha", branch, { _tag: "CreatingWorktree" }),
    );
    const labels = rows.flatMap((row) =>
      row.kind === "lifecycle-progress" ? [lifecyclePhaseLabel(row.phase)] : [],
    );
    expect(labels).toEqual(["Creating worktree…"]);
    const clean = rowsFor(repos, new Map());
    expect(
      clean.rows.some(
        (row) =>
          row.kind === "lifecycle-progress" || row.kind === "pending-workspace",
      ),
    ).toBe(false);
  });

  test("neither the progress row nor the Pending Workspace is keyboard- or mouse-reachable", () => {
    const branch = "feature/x";
    const pendingBranch = "feature/new";
    const repos = repoWithWorktree(branch);
    const lifecycle = new Map<string, LifecycleEntry>([
      ...openLifecycle(repoPath, "alpha", branch, {
        _tag: "CopyingFiles",
      }).entries(),
      ...openLifecycle(repoPath, "alpha", pendingBranch, {
        _tag: "Preparing",
      }).entries(),
    ]);
    const { items, rows } = rowsFor(repos, lifecycle);

    const lifecycleRows = rows.filter(
      (row) =>
        row.kind === "lifecycle-progress" || row.kind === "pending-workspace",
    );
    expect(lifecycleRows).toHaveLength(3);
    // resolveMouseAction/resolveHoverItemIndex both refuse a row with a null itemIndex.
    for (const row of lifecycleRows) {
      expect(row.itemIndex).toBeNull();
    }
    // Navigation walks `items`, which has no entry for the pending workspace.
    expect(
      items.some(
        (item) =>
          item.type === "worktree" &&
          repos[item.repoIndex]?.worktrees[item.worktreeIndex]?.branch ===
            pendingBranch,
      ),
    ).toBe(false);
    for (let idx = 0; idx < items.length; idx++) {
      const rowIndex = firstRowForItem(rows, idx);
      expect(rowIndex).not.toBeNull();
      expect(rows[rowIndex as number]?.kind).not.toBe("lifecycle-progress");
      expect(rows[rowIndex as number]?.kind).not.toBe("pending-workspace");
    }
  });

  test("progress rows are counted by the shared row model and stay inert to the pointer", () => {
    const branch = "feature/x";
    const repos = repoWithWorktree(branch);
    repos[0]?.worktrees.push({
      branch: "feature/y",
      path: "/tmp/alpha-y",
      isMainWorktree: false,
      changedFiles: 0,
      sync: { ahead: 0, behind: 0 },
    });

    const clean = rowsFor(repos, new Map());
    const active = rowsFor(
      repos,
      openLifecycle(repoPath, "alpha", branch, { _tag: "CopyingFiles" }),
    );

    // The progress row is a real visual row: same logical items, one extra row.
    expect(active.items).toEqual(clean.items);
    expect(active.rows).toHaveLength(clean.rows.length + 1);
    const progressRowIndex = active.rows.findIndex(
      (row) => row.kind === "lifecycle-progress",
    );
    expect(progressRowIndex).toBeGreaterThan(-1);
    const siblingItemIndex = active.items.findIndex(
      (item) =>
        item.type === "worktree" &&
        repos[item.repoIndex]?.worktrees[item.worktreeIndex]?.branch ===
          "feature/y",
    );
    expect(firstRowForItem(active.rows, siblingItemIndex)).toBe(
      (firstRowForItem(clean.rows, siblingItemIndex) as number) + 1,
    );

    // The same rows drive the pointer: the progress row refuses click and hover.
    const ctx = {
      mode: Mode.Navigate,
      rows: active.rows,
      effectiveScrollOffset: 0,
      viewportRows: active.rows.length,
      treeItems: active.items,
      repos,
    };
    const sgrRow = (rowIndex: number) => rowIndex + 1 + HEADER_OFFSET;
    expect(
      resolveMouseAction(
        {
          kind: "press",
          button: "left",
          col: 5,
          row: sgrRow(progressRowIndex),
        },
        ctx,
      ),
    ).toEqual({ kind: "none" });
    expect(
      resolveHoverItemIndex(
        { kind: "move", col: 5, row: sgrRow(progressRowIndex) },
        ctx,
      ),
    ).toBeNull();
    expect(
      resolveMouseAction(
        {
          kind: "press",
          button: "left",
          col: 5,
          row: sgrRow(progressRowIndex + 1),
        },
        ctx,
      ),
    ).toEqual({
      kind: "select",
      itemIndex: siblingItemIndex,
      rowIndex: progressRowIndex + 1,
    });
  });
});

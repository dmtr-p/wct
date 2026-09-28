import { describe, expect, test, vi } from "vitest";
import type { PrFacts } from "../../src/services/pr-model";
import { displayPr } from "../../src/tui/hooks/useGitHub";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { lifecycleKey } from "../../src/tui/lifecycle";
import {
  compactPrSegments,
  compactPrText,
  derivePrPresentation,
} from "../../src/tui/pr-status";
import {
  buildTreeItems,
  buildTreeRows,
  firstRowForItem,
  openPrInBrowser,
  prExpansionKey,
  resolveRecoveredSelectionIndex,
  treeItemId,
  treeItemParentId,
} from "../../src/tui/tree-helpers";

function facts(overrides: Partial<PrFacts> = {}): PrFacts {
  return {
    baseRepository: "base/repo",
    number: 150,
    id: "PR-id",
    url: "https://github.com/base/repo/pull/150",
    title: "Fix session cleanup",
    state: "OPEN",
    isDraft: false,
    headRepository: "alice/repo",
    headRefName: "feature",
    headOid: "abc",
    baseRefName: "main",
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    isMergeQueueEnabled: false,
    isQueued: false,
    updatedAt: "2026-09-27T00:00:00Z",
    checks: [{ name: "test", outcome: "passed", required: true }],
    checksComplete: true,
    fetchedAt: 1,
    lastError: null,
    ...overrides,
  };
}

describe("PR status derivation", () => {
  test.each([
    [{ state: "MERGED" }, "merged"],
    [{ state: "CLOSED" }, "closed"],
    [{ isDraft: true }, "draft"],
    [{ mergeable: "CONFLICTING" }, "conflicts"],
    [{ reviewDecision: "CHANGES_REQUESTED" }, "changes requested"],
    [{ isQueued: true }, "queued"],
    [
      { checks: [{ name: "test", outcome: "failed", required: true }] },
      "checks failed",
    ],
    [{ mergeStateStatus: "BEHIND" }, "behind base"],
    [{ reviewDecision: "REVIEW_REQUIRED" }, "awaiting review"],
    [
      { checks: [{ name: "test", outcome: "pending", required: true }] },
      "checks pending",
    ],
    [{ checksComplete: false }, "unknown"],
    [{ checks: null }, "unknown"],
    [{ checksComplete: false, mergeStateStatus: "BLOCKED" }, "blocked"],
    [{ mergeStateStatus: "BLOCKED" }, "blocked"],
    [{}, "ready"],
    [{ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, "checking…"],
  ] as const)("selects primary status for %j", (overrides, expected) => {
    expect(
      derivePrPresentation(facts(overrides as Partial<PrFacts>)).primary,
    ).toBe(expected);
  });

  test("optional failure stays secondary when GitHub reports mergeable", () => {
    const status = derivePrPresentation(
      facts({
        mergeStateStatus: "UNSTABLE",
        checks: [{ name: "optional", outcome: "failed", required: null }],
      }),
    );
    expect(status.primary).toBe("ready");
    expect(status.checks).toBe("failure");
    expect(
      status.details.find((detail) => detail.key === "checks")?.text,
    ).toContain("optional or unclassified failed");
  });

  test("failed checks beat running checks in the compact summary", () => {
    const status = derivePrPresentation(
      facts({
        checks: [
          { name: "optional", outcome: "failed", required: false },
          { name: "running", outcome: "pending", required: false },
        ],
        mergeStateStatus: "BLOCKED",
      }),
    );
    expect(status.primary).toBe("blocked");
    expect(status.checks).toBe("failure");
    expect(
      status.details.find((detail) => detail.key === "checks")?.text,
    ).toContain("pending");
  });

  test("unknown block cause is not invented", () => {
    expect(
      derivePrPresentation(facts({ mergeStateStatus: "BLOCKED" })).details.find(
        (detail) => detail.key === "merge",
      )?.text,
    ).toBe("Merge: blocked");
  });

  test("merge detail follows the primary status when queued checks fail", () => {
    const status = derivePrPresentation(
      facts({
        isQueued: true,
        checks: [{ name: "test", outcome: "failed", required: true }],
      }),
    );
    expect(status.primary).toBe("queued");
    expect(status.details.find((detail) => detail.key === "merge")?.text).toBe(
      "Merge: queued",
    );
  });

  test("multi-line fetch errors stay on one detail row", () => {
    const status = derivePrPresentation(
      facts({ lastError: "fatal: offline\nhint: retry" }),
    );
    expect(status.details.find((detail) => detail.key === "updated")?.text).toContain(
      "fatal: offline hint: retry",
    );
  });

  test("cancelled and unknown checks never show passed", () => {
    const status = derivePrPresentation(
      facts({
        checks: [{ name: "test", outcome: "cancelled", required: true }],
      }),
    );
    expect(status.checks).toBe("unknown");
    expect(
      status.details.find((detail) => detail.key === "checks")?.text,
    ).toContain("cancelled");
  });

  test("compact row omits title, drops checks first, and preserves stale", () => {
    const status = derivePrPresentation(facts({ lastError: "offline" }));
    expect(compactPrText(150, status, 80)).toContain(
      "ready · checks ✓ · stale",
    );
    expect(compactPrText(150, status, 80)).not.toContain("Fix session cleanup");
    expect(compactPrText(150, status, 18)).toContain("#150 stale");
    expect(compactPrText(0, status, 18)).toContain("#? stale");
    expect(compactPrText(-1, status, 18)).toContain("#? stale");
    expect(compactPrText(150, status, 7).length).toBeLessThanOrEqual(7);
    const segments = compactPrSegments(150, status, 18);
    expect(segments.map((segment) => segment.text).join("")).toBe(
      compactPrText(150, status, 18),
    );
    expect(segments.map((segment) => segment.kind)).toContain("number");
    expect(segments.map((segment) => segment.kind)).toContain("stale");
    expect(
      compactPrSegments(150, derivePrPresentation(facts()), 16).some(
        (segment) => segment.kind === "status" && segment.text.length > 0,
      ),
    ).toBe(true);
  });
});

function repo(): RepoInfo {
  return {
    id: "repo",
    repoPath: "/repo",
    project: "repo",
    profileNames: [],
    worktrees: [
      {
        branch: "feature",
        path: "/repo-feature",
        isMainWorktree: false,
        changedFiles: 0,
        sync: null,
      },
    ],
  };
}

describe("PR tree rows", () => {
  test("opens PR URLs through GitHub CLI on every platform", () => {
    const spawn = vi.spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
    } as unknown as ReturnType<typeof Bun.spawn>);
    try {
      openPrInBrowser("/repo", 150, "https://github.com/base/repo/pull/150");
      expect(spawn).toHaveBeenCalledWith(
        [
          "gh",
          "pr",
          "view",
          "--web",
          "https://github.com/base/repo/pull/150",
        ],
        { cwd: "/repo" },
      );
    } finally {
      spawn.mockRestore();
    }
  });

  test("wrapped Unicode title remains one selectable item across visual rows", () => {
    const pr = facts({ title: "修正 session cleanup 🧪 ".repeat(6) });
    const identity = lifecycleKey("/repo", "feature");
    const prKey = prExpansionKey(identity, pr);
    const items = buildTreeItems({
      repos: [repo()],
      expandedWorktreeKeys: new Set(["repo/feature"]),
      prData: new Map([[identity, displayPr(pr)]]),
      expandedPrKeys: new Set([prKey]),
      panes: new Map(),
      jumpToPane: () => {},
    });
    const titleIndex = items.findIndex(
      (item) => item.type === "detail" && item.detailKind === "pr-title",
    );
    const rows = buildTreeRows({
      items,
      repos: [repo()],
      expandedWorktreeKeys: new Set(["repo/feature"]),
      maxWidth: 28,
    });
    expect(
      rows.filter((row) => row.itemIndex === titleIndex).length,
    ).toBeGreaterThan(1);
    expect(firstRowForItem(rows, titleIndex)).not.toBeNull();
    expect(
      new Set(
        rows
          .filter((row) => row.itemIndex === titleIndex)
          .map((row) => row.itemIndex),
      ),
    ).toEqual(new Set([titleIndex]));
  });

  test("candidate group has Workspace identity and removal recovers to group", () => {
    const candidate = facts();
    const identity = lifecycleKey("/repo", "feature");
    const associations = new Map([
      [
        identity,
        {
          pr: null,
          candidates: [candidate],
          newerOpenPr: null,
          uncertain: true,
          fetchedAt: 1,
          lastError: null,
        },
      ],
    ]);
    const build = (expanded: boolean) =>
      buildTreeItems({
        repos: [repo()],
        expandedWorktreeKeys: new Set(["repo/feature"]),
        prData: new Map(),
        associations,
        expandedPrKeys: expanded
          ? new Set([`${identity}\0candidates`])
          : new Set(),
        panes: new Map(),
        jumpToPane: () => {},
      });
    const before = build(true);
    const selectedIndex = before.findIndex(
      (item) => item.type === "detail" && item.detailKind === "candidate",
    );
    const selected = before[selectedIndex];
    expect(selected).toBeDefined();
    if (!selected) return;
    const after = build(false);
    const recovered = resolveRecoveredSelectionIndex({
      prevTree: before,
      treeItems: after,
      prevSelectionId: treeItemId(selected, [repo()]),
      prevSelectionParentId: treeItemParentId(selected, [repo()]),
      selectedIndex,
      repos: [repo()],
    });
    expect(after[recovered ?? -1]).toMatchObject({
      type: "detail",
      detailKind: "candidate-group",
    });
  });

  test("expanding the same PR in one Workspace leaves the other collapsed", () => {
    const sharedPr = facts();
    const first = lifecycleKey("/repo", "feature");
    const second = lifecycleKey("/repo", "other");
    const multiRepo = repo();
    multiRepo.worktrees.push({
      branch: "other",
      path: "/repo-other",
      isMainWorktree: false,
      changedFiles: 0,
      sync: null,
    });
    const items = buildTreeItems({
      repos: [multiRepo],
      expandedWorktreeKeys: new Set(["repo/feature", "repo/other"]),
      prData: new Map([
        [first, displayPr(sharedPr)],
        [second, displayPr(sharedPr)],
      ]),
      expandedPrKeys: new Set([prExpansionKey(first, sharedPr)]),
      panes: new Map(),
      jumpToPane: () => {},
    });
    expect(
      items.filter(
        (item) => item.type === "detail" && item.detailKind === "pr-title",
      ),
    ).toHaveLength(1);
  });

  test("selection recovery does not infer detail type from a branch name", () => {
    const namedRepo = repo();
    namedRepo.worktrees[0]!.branch = "feat/pr/login";
    namedRepo.worktrees.push({
      branch: "other",
      path: "/repo-other",
      isMainWorktree: false,
      changedFiles: 0,
      sync: null,
    });
    const pane = {
      type: "detail" as const,
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane" as const,
      label: "shell",
      meta: { paneId: "pane-1", window: "0", paneIndex: 0, command: "zsh" },
    };
    const after = [
      { type: "repo" as const, repoIndex: 0 },
      { type: "worktree" as const, repoIndex: 0, worktreeIndex: 0 },
      { type: "worktree" as const, repoIndex: 0, worktreeIndex: 1 },
    ];
    const before = [...after.slice(0, 2), pane, after[2]!];
    expect(
      resolveRecoveredSelectionIndex({
        prevTree: before,
        treeItems: after,
        prevSelectionId: treeItemId(pane, [namedRepo]),
        prevSelectionParentId: treeItemParentId(pane, [namedRepo]),
        selectedIndex: 2,
        repos: [namedRepo],
      }),
    ).toBeNull();
  });
});

import { describe, expect, test, vi } from "vitest";
import type { PrFacts } from "../../src/services/pr-model";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { workspaceIdentityKey } from "../../src/tui/lifecycle";
import {
  compactPrSegments,
  derivePrPresentation,
  type PrPrimaryStatus,
  type PrTone,
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

function compactPrText(...args: Parameters<typeof compactPrSegments>): string {
  return compactPrSegments(...args)
    .map((segment) => segment.text)
    .join("");
}

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
    [{ state: "MERGED" }, "merged", "mauve", true, "merged"],
    [{ state: "CLOSED" }, "closed", "muted", false, "closed"],
    [{ isDraft: true }, "draft", "muted", false, "blocked (draft)"],
    [
      { mergeable: "CONFLICTING" },
      "conflicts",
      "red",
      true,
      "blocked (conflicts)",
    ],
    [
      { reviewDecision: "CHANGES_REQUESTED" },
      "changes requested",
      "yellow",
      true,
      "blocked (changes requested)",
    ],
    [{ isQueued: true }, "queued", "yellow", false, "queued"],
    [
      { checks: [{ name: "test", outcome: "failed", required: true }] },
      "checks failed",
      "red",
      true,
      "blocked (required checks failed)",
    ],
    [
      { mergeStateStatus: "BEHIND" },
      "behind base",
      "yellow",
      false,
      "blocked (behind base)",
    ],
    [
      { reviewDecision: "REVIEW_REQUIRED" },
      "awaiting review",
      "yellow",
      false,
      "blocked (review required)",
    ],
    [
      { checks: [{ name: "test", outcome: "pending", required: true }] },
      "checks pending",
      "yellow",
      false,
      "checks pending",
    ],
    [{ checksComplete: false }, "unknown", "muted", false, "unknown"],
    [{ checks: null }, "unknown", "muted", false, "unknown"],
    [
      { checksComplete: false, mergeStateStatus: "BLOCKED" },
      "blocked",
      "muted",
      false,
      "blocked",
    ],
    [{ mergeStateStatus: "BLOCKED" }, "blocked", "muted", false, "blocked"],
    [{}, "ready", "green", true, "ready"],
    [{ checks: [] }, "ready", "green", true, "ready"],
    [
      { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
      "checking…",
      "yellow",
      false,
      "checking…",
    ],
    [{ mergeStateStatus: "UNKNOWN" }, "unknown", "muted", false, "unknown"],
    [{ mergeStateStatus: null }, "unknown", "muted", false, "unknown"],
    [{ isDraft: null }, "open", "muted", false, "open"],
  ] satisfies [Partial<PrFacts>, PrPrimaryStatus, PrTone, boolean, string][])(
    "selects primary status for %j",
    (overrides: Partial<PrFacts>, primary, tone, bold, merge) => {
      const status = derivePrPresentation(facts(overrides));
      expect(status).toMatchObject({ primary, tone, bold });
      expect(status.stale).toBe(overrides.checksComplete === false);
      expect(
        status.details.find((detail) => detail.key === "merge")?.text,
      ).toBe(`Merge: ${merge}`);
    },
  );

  test.each([
    [
      {
        state: "MERGED",
        isDraft: true,
        mergeable: "CONFLICTING",
        isQueued: true,
      },
      "merged",
    ],
    [{ state: "CLOSED", isDraft: true, mergeable: "CONFLICTING" }, "closed"],
    [
      {
        isDraft: true,
        mergeable: "CONFLICTING",
        reviewDecision: "CHANGES_REQUESTED",
      },
      "draft",
    ],
    [
      {
        mergeStateStatus: "DIRTY",
        reviewDecision: "CHANGES_REQUESTED",
        isQueued: true,
      },
      "conflicts",
    ],
    [
      {
        reviewDecision: "CHANGES_REQUESTED",
        isQueued: true,
        checks: [{ name: "test", outcome: "failed", required: true }],
      },
      "changes requested",
    ],
    [
      {
        mergeStateStatus: "BEHIND",
        reviewDecision: "REVIEW_REQUIRED",
        checks: [{ name: "test", outcome: "failed", required: true }],
      },
      "checks failed",
    ],
    [
      {
        mergeStateStatus: "BEHIND",
        reviewDecision: "REVIEW_REQUIRED",
        checks: [{ name: "test", outcome: "pending", required: true }],
      },
      "behind base",
    ],
    [
      {
        reviewDecision: "REVIEW_REQUIRED",
        checks: [{ name: "test", outcome: "pending", required: true }],
      },
      "awaiting review",
    ],
    [
      {
        mergeStateStatus: "BLOCKED",
        checks: [{ name: "test", outcome: "pending", required: true }],
      },
      "checks pending",
    ],
    [
      {
        mergeStateStatus: "BLOCKED",
        checks: [{ name: "optional", outcome: "pending", required: false }],
      },
      "checks pending",
    ],
    [
      { checks: null, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
      "unknown",
    ],
  ] satisfies [Partial<PrFacts>, PrPrimaryStatus][])(
    "preserves primary precedence for overlapping facts %j",
    (overrides: Partial<PrFacts>, primary) => {
      expect(derivePrPresentation(facts(overrides)).primary).toBe(primary);
    },
  );

  test.each([
    [{ state: "MERGED" }, "merged"],
    [{ isQueued: true }, "queued"],
    [{ mergeable: "CONFLICTING" }, "conflicts"],
    [
      { checks: [{ name: "test", outcome: "failed", required: true }] },
      "checks failed",
    ],
    [
      { checks: [{ name: "test", outcome: "pending", required: true }] },
      "checks pending",
    ],
  ] satisfies [Partial<PrFacts>, PrPrimaryStatus][])(
    "retains primary status with incomplete checks for %j",
    (overrides: Partial<PrFacts>, primary) => {
      const status = derivePrPresentation(
        facts({ ...overrides, checksComplete: false }),
      );
      expect(status).toMatchObject({ primary, stale: true });
      expect(status.checks).toBe(
        overrides.state === "MERGED" ? null : "unknown",
      );
      expect(
        status.details.find((detail) => detail.key === "checks")?.text,
      ).toBe("Checks: unknown");
    },
  );

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
    expect(
      status.details.find((detail) => detail.key === "updated")?.text,
    ).toContain("fatal: offline hint: retry");
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
        ["gh", "pr", "view", "--web", "https://github.com/base/repo/pull/150"],
        { cwd: "/repo" },
      );
    } finally {
      spawn.mockRestore();
    }
  });

  test("wrapped Unicode title remains one selectable item across visual rows", () => {
    const pr = facts({ title: "修正 session cleanup 🧪 ".repeat(6) });
    const identity = workspaceIdentityKey("/repo", "feature");
    const prKey = prExpansionKey(identity, pr);
    const items = buildTreeItems({
      repos: [repo()],
      expandedWorkspaceKeys: new Set([
        workspaceIdentityKey("/repo", "feature"),
      ]),
      prData: new Map([[identity, pr]]),
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
      expandedWorkspaceKeys: new Set([
        workspaceIdentityKey("/repo", "feature"),
      ]),
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

  test.each(["pr-title", "pr-fact"] as const)(
    "collapsing a PR recovers a selected %s to its compact row",
    (detailKind) => {
      const pr = facts();
      const identity = workspaceIdentityKey("/repo", "feature");
      const build = (expanded: boolean) =>
        buildTreeItems({
          repos: [repo()],
          expandedWorkspaceKeys: new Set([identity]),
          expandedPrKeys: expanded
            ? new Set([prExpansionKey(identity, pr)])
            : new Set(),
          prData: new Map([[identity, pr]]),
          panes: new Map(),
          jumpToPane: () => {},
        });
      const before = build(true);
      const selectedIndex = before.findIndex(
        (item) => item.type === "detail" && item.detailKind === detailKind,
      );
      const selected = before[selectedIndex];
      if (!selected) throw new Error("Missing PR detail");
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
        detailKind: "pr",
        meta: { prKey: prExpansionKey(identity, pr), expanded: false },
      });
    },
  );

  test("candidate group has Workspace identity and removal recovers to group", () => {
    const candidate = facts();
    const identity = workspaceIdentityKey("/repo", "feature");
    const associations = new Map([
      [
        identity,
        {
          pr: null,
          candidates: [candidate],
          newerOpenPr: null,
          fetchedAt: 1,
          lastError: null,
        },
      ],
    ]);
    const build = (expanded: boolean) =>
      buildTreeItems({
        repos: [repo()],
        expandedWorkspaceKeys: new Set([
          workspaceIdentityKey("/repo", "feature"),
        ]),
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
    const first = workspaceIdentityKey("/repo", "feature");
    const second = workspaceIdentityKey("/repo", "other");
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
      expandedWorkspaceKeys: new Set([
        workspaceIdentityKey("/repo", "feature"),
        workspaceIdentityKey("/repo", "other"),
      ]),
      prData: new Map([
        [first, sharedPr],
        [second, sharedPr],
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
    const firstWorktree = namedRepo.worktrees[0];
    if (!firstWorktree) throw new Error("Missing fixture worktree");
    firstWorktree.branch = "feat/pr/login";
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
    const repoItem = { type: "repo" as const, repoIndex: 0 };
    const firstItem = {
      type: "worktree" as const,
      repoIndex: 0,
      worktreeIndex: 0,
    };
    const secondItem = {
      type: "worktree" as const,
      repoIndex: 0,
      worktreeIndex: 1,
    };
    const after = [repoItem, firstItem, secondItem];
    const before = [repoItem, firstItem, pane, secondItem];
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

import React from "react";
import { describe, expect, test } from "vitest";
import { LifecycleProgressRow } from "../../src/tui/components/LifecycleProgressRow";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import {
  LIFECYCLE_ROW_PREFIX,
  type LifecycleEntry,
  type LifecyclePhase,
  type LifecycleState,
  lifecycleKey,
  lifecyclePhaseLabel,
  lifecycleProgressContent,
} from "../../src/tui/lifecycle";
import {
  buildTreeItems,
  buildTreeRows,
  isWorktreeEffectivelyExpanded,
  reconcileDiscoveredWorkspaceKeys,
  reconcileExpandedWorktreeKeys,
  workspaceIdentityKeysForDisplayKey,
} from "../../src/tui/tree-helpers";
import { pendingKey } from "../../src/tui/types";
import { displayWidth } from "../../src/tui/utils/display-width";
import { elementText, hasElementProp } from "./react-elements";

function lifecycleOf(
  repoPath: string,
  project: string,
  branch: string,
  phase: LifecyclePhase,
  operation: LifecycleEntry["operation"] = "open",
): LifecycleState {
  return new Map([
    [
      lifecycleKey(repoPath, branch),
      { operation, repoPath, project, branch, phase },
    ],
  ]);
}

describe("lifecyclePhaseLabel", () => {
  test("maps every phase to its canonical label", () => {
    expect(lifecyclePhaseLabel({ _tag: "Preparing" })).toBe(
      "Preparing Workspace…",
    );
    expect(lifecyclePhaseLabel({ _tag: "CreatingWorktree" })).toBe(
      "Creating worktree…",
    );
    expect(lifecyclePhaseLabel({ _tag: "CopyingFiles" })).toBe(
      "Copying files…",
    );
    expect(
      lifecyclePhaseLabel({ _tag: "RunningSetup", name: "bun install" }),
    ).toBe("Setup: bun install…");
    expect(lifecyclePhaseLabel({ _tag: "CreatingTmuxSession" })).toBe(
      "Creating tmux session…",
    );
    expect(lifecyclePhaseLabel({ _tag: "KillingTmuxSession" })).toBe(
      "Killing tmux session…",
    );
    expect(lifecyclePhaseLabel({ _tag: "RemovingWorktree" })).toBe(
      "Removing worktree…",
    );
    expect(lifecyclePhaseLabel({ _tag: "Validating" })).toBe(
      "Validating Workspace…",
    );
  });

  test.each([
    ["install\nbuild", "Setup: install build…"],
    ["install\r\n    build", "Setup: install build…"],
    ["install\r    build", "Setup: install build…"],
    ["  install\n\tbuild  ", "Setup: install build…"],
  ])("normalizes setup name %j onto one physical row", (name, expected) => {
    const label = lifecyclePhaseLabel({ _tag: "RunningSetup", name });

    expect(label).toBe(expected);
    expect(label).not.toMatch(/[\r\n]/);
  });

  test("normalizes before display-width truncation at both fitting and narrow widths", () => {
    const phase = {
      _tag: "RunningSetup" as const,
      name: "install\r\n    dependencies",
    };
    const label = "Setup: install dependencies…";
    const fittingWidth = LIFECYCLE_ROW_PREFIX.length + displayWidth(label);

    expect(lifecycleProgressContent(phase, fittingWidth)).toBe(
      `${LIFECYCLE_ROW_PREFIX}${label}`,
    );
    for (const width of [1, LIFECYCLE_ROW_PREFIX.length, 12]) {
      const content = lifecycleProgressContent(phase, width);
      expect(content).not.toMatch(/[\r\n]/);
      expect(displayWidth(content)).toBeLessThanOrEqual(width);
    }
  });
});

describe("LifecycleProgressRow", () => {
  test("renders a static child connector in yellow, truncated, with no spinner", () => {
    const longName = "install-every-single-dependency-in-the-whole-monorepo";
    const element = React.createElement(LifecycleProgressRow, {
      phase: { _tag: "RunningSetup", name: longName },
      maxWidth: 40,
    });
    const rendered = LifecycleProgressRow({
      phase: { _tag: "RunningSetup", name: longName },
      maxWidth: 40,
    });

    expect(hasElementProp(rendered, "color", "yellow")).toBe(true);
    expect(hasElementProp(rendered, "wrap", "truncate")).toBe(true);
    const text = elementText(rendered);
    expect(text.startsWith(LIFECYCLE_ROW_PREFIX)).toBe(true);
    const body = text.slice(LIFECYCLE_ROW_PREFIX.length);
    for (const spinnerFrame of ["⠋", "⠙", "⠹", "⠸", "◐", "◓", "◑", "▪"]) {
      expect(body).not.toContain(spinnerFrame);
    }
    expect(/[0-9]/.test(body)).toBe(false);
    expect(
      elementText(
        LifecycleProgressRow({
          phase: { _tag: "RunningSetup", name: longName },
          maxWidth: 40,
        }),
      ),
    ).toBe(text);
    expect(displayWidth(text)).toBeLessThanOrEqual(40);
    expect(text).toContain("Setup: ");
    expect(text).not.toContain(longName);
    expect(text).toContain("…");
    expect(text).toBe(
      lifecycleProgressContent({ _tag: "RunningSetup", name: longName }, 40),
    );
    expect(React.isValidElement(element)).toBe(true);
  });
});

describe("forced expansion is presentation-only", () => {
  // The row-model half; the orchestration half (a registry poll mid-operation
  // can't disturb it) is in app-lifecycle-close.test.tsx.
  test("lifecycle expansion never touches the stored expandedWorktreeKeys", () => {
    const repoPath = "/repos/alpha";
    const branch = "feature/x";
    const repos: RepoInfo[] = [
      {
        id: "repo-1",
        repoPath,
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
        profileNames: [],
      },
    ];
    const stored = new Set<string>();
    const lifecycle = lifecycleOf(repoPath, "alpha", branch, {
      _tag: "CreatingWorktree",
    });

    expect(
      isWorktreeEffectivelyExpanded({
        expandedWorktreeKeys: stored,
        lifecycle,
        project: "alpha",
        repoPath,
        branch,
      }),
    ).toBe(true);
    expect(
      isWorktreeEffectivelyExpanded({
        expandedWorktreeKeys: stored,
        lifecycle: new Map(),
        project: "alpha",
        repoPath,
        branch,
      }),
    ).toBe(false);

    const items = buildTreeItems({
      repos,
      expandedWorktreeKeys: stored,
      lifecycle,
      prData: new Map(),
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    buildTreeRows({
      items,
      repos,
      expandedWorktreeKeys: stored,
      lifecycle,
      maxWidth: 80,
    });

    // `reconcileExpandedWorktreeKeys` prunes on every repos change (the 5s
    // poll included), so the stored preference must stay untouched here.
    expect(stored.size).toBe(0);
    expect(stored.has(pendingKey("alpha", branch))).toBe(false);
    expect(reconcileExpandedWorktreeKeys(stored, repos)).toBe(stored);
    expect(reconcileExpandedWorktreeKeys(stored, [])).toBe(stored);
  });
});

describe("discovered Workspace expansion", () => {
  test("keys the override by Workspace Identity when display keys collide", () => {
    const branch = "feat";
    const repos: RepoInfo[] = [
      {
        id: "repo-a",
        repoPath: "/repos/a",
        project: "same-name",
        worktrees: [
          {
            branch,
            path: "/repos/a-feat",
            isMainWorktree: false,
            changedFiles: 1,
            sync: null,
          },
        ],
        profileNames: [],
      },
      {
        id: "repo-b",
        repoPath: "/repos/b",
        project: "same-name",
        worktrees: [
          {
            branch,
            path: "/repos/b-feat",
            isMainWorktree: false,
            changedFiles: 1,
            sync: null,
          },
        ],
        profileNames: [],
      },
    ];
    const storedPresentationKeys = new Set<string>();
    const discoveredWorkspaceKeys = new Set([lifecycleKey("/repos/a", branch)]);

    expect(
      isWorktreeEffectivelyExpanded({
        expandedWorktreeKeys: storedPresentationKeys,
        discoveredWorkspaceKeys,
        project: "same-name",
        repoPath: "/repos/a",
        branch,
      }),
    ).toBe(true);
    expect(
      isWorktreeEffectivelyExpanded({
        expandedWorktreeKeys: storedPresentationKeys,
        discoveredWorkspaceKeys,
        project: "same-name",
        repoPath: "/repos/b",
        branch,
      }),
    ).toBe(false);

    const items = buildTreeItems({
      repos,
      expandedWorktreeKeys: storedPresentationKeys,
      discoveredWorkspaceKeys,
      prData: new Map(),
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedWorktreeKeys: storedPresentationKeys,
      discoveredWorkspaceKeys,
      maxWidth: 80,
    });

    expect(
      rows.flatMap((row) =>
        row.kind === "worktree-stats" ? [row.repoIndex] : [],
      ),
    ).toEqual([0]);
    expect(
      reconcileDiscoveredWorkspaceKeys(discoveredWorkspaceKeys, repos),
    ).toBe(discoveredWorkspaceKeys);
    expect(
      reconcileDiscoveredWorkspaceKeys(discoveredWorkspaceKeys, repos.slice(1)),
    ).toEqual(new Set());

    const displayKey = pendingKey("same-name", branch);
    const storedWithCollision = new Set([displayKey]);
    const overridesAfterCollapsingA = new Set(discoveredWorkspaceKeys);
    const identitiesToPreserve = workspaceIdentityKeysForDisplayKey(
      repos,
      displayKey,
    );
    identitiesToPreserve.delete(lifecycleKey("/repos/a", branch));
    overridesAfterCollapsingA.delete(lifecycleKey("/repos/a", branch));
    for (const identity of identitiesToPreserve) {
      overridesAfterCollapsingA.add(identity);
    }
    storedWithCollision.delete(displayKey);

    expect(
      isWorktreeEffectivelyExpanded({
        expandedWorktreeKeys: storedWithCollision,
        discoveredWorkspaceKeys: overridesAfterCollapsingA,
        project: "same-name",
        repoPath: "/repos/a",
        branch,
      }),
    ).toBe(false);
    expect(
      isWorktreeEffectivelyExpanded({
        expandedWorktreeKeys: storedWithCollision,
        discoveredWorkspaceKeys: overridesAfterCollapsingA,
        project: "same-name",
        repoPath: "/repos/b",
        branch,
      }),
    ).toBe(true);
  });
});

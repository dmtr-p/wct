import React from "react";
import { describe, expect, test } from "vitest";
import {
  RegistrationId,
  type WorkspaceIdentityKey,
} from "../../src/services/identities";
import { LifecycleProgressRow } from "../../src/tui/components/LifecycleProgressRow";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import {
  LIFECYCLE_ROW_PREFIX,
  type LifecycleEntry,
  type LifecyclePhase,
  lifecyclePhaseLabel,
  lifecycleProgressContent,
  type LifecycleState,
  workspaceIdentityKey,
} from "../../src/tui/lifecycle";
import {
  buildTreeItems,
  buildTreeRows,
  isWorktreeEffectivelyExpanded,
  reconcileExpandedWorkspaceKeys,
} from "../../src/tui/tree-helpers";
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
      workspaceIdentityKey(repoPath, branch),
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
    expect(
      lifecyclePhaseLabel({ _tag: "RunningDown", name: "Stop\ncontainers" }),
    ).toBe("Down: Stop containers…");
    expect(lifecyclePhaseLabel({ _tag: "StartingTmuxSession" })).toBe(
      "Starting tmux session…",
    );
    expect(lifecyclePhaseLabel({ _tag: "StoppingTmuxSession" })).toBe(
      "Stopping tmux session…",
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
  test("lifecycle expansion never touches the stored expandedWorkspaceKeys", () => {
    const repoPath = "/repos/alpha";
    const branch = "feature/x";
    const repos: RepoInfo[] = [
      {
        id: RegistrationId("repo-1"),
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
    const stored = new Set<WorkspaceIdentityKey>();
    const lifecycle = lifecycleOf(repoPath, "alpha", branch, {
      _tag: "CreatingWorktree",
    });

    expect(
      isWorktreeEffectivelyExpanded({
        expandedWorkspaceKeys: stored,
        lifecycle,
        repoPath,
        branch,
      }),
    ).toBe(true);
    expect(
      isWorktreeEffectivelyExpanded({
        expandedWorkspaceKeys: stored,
        lifecycle: new Map(),
        repoPath,
        branch,
      }),
    ).toBe(false);

    const items = buildTreeItems({
      repos,
      expandedWorkspaceKeys: stored,
      lifecycle,
      prData: new Map(),
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    buildTreeRows({
      items,
      repos,
      expandedWorkspaceKeys: stored,
      lifecycle,
      maxWidth: 80,
    });

    expect(stored.size).toBe(0);
    expect(stored.has(workspaceIdentityKey(repoPath, branch))).toBe(false);
    expect(reconcileExpandedWorkspaceKeys(stored, repos)).toBe(stored);
    expect(reconcileExpandedWorkspaceKeys(stored, [])).toBe(stored);
  });
});

describe("Workspace expansion preferences", () => {
  const branch = "feature/a";
  const repos: RepoInfo[] = ["a", "b"].map((name) => ({
    id: RegistrationId(name),
    repoPath: `/repos/${name}`,
    project: "org/same-name",
    worktrees: [
      {
        branch,
        path: `/repos/${name}-feat`,
        isMainWorktree: false,
        changedFiles: 1,
        sync: null,
      },
    ],
    profileNames: [],
  }));
  const a = workspaceIdentityKey("/repos/a", branch);
  const b = workspaceIdentityKey("/repos/b", branch);

  test("expands only the selected identity despite matching display names and branches", () => {
    const expandedWorkspaceKeys = new Set([a]);
    const items = buildTreeItems({
      repos,
      expandedWorkspaceKeys,
      prData: new Map(),
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({ items, repos, expandedWorkspaceKeys });
    expect(
      rows.flatMap((row) =>
        row.kind === "worktree-stats" ? [row.repoIndex] : [],
      ),
    ).toEqual([0]);
    expect(
      isWorktreeEffectivelyExpanded({
        expandedWorkspaceKeys,
        repoPath: "/repos/b",
        branch,
      }),
    ).toBe(false);
  });

  test("retains preferences through a display-name change and prunes only removed identities", () => {
    const stored = new Set([a, b]);
    const renamed = repos.map((repo) => ({ ...repo, project: "new/name" }));
    expect(reconcileExpandedWorkspaceKeys(stored, renamed)).toBe(stored);
    expect(reconcileExpandedWorkspaceKeys(stored, renamed.slice(1))).toEqual(
      new Set([b]),
    );
    expect(
      isWorktreeEffectivelyExpanded({
        expandedWorkspaceKeys: stored,
        repoPath: "/repos/a",
        branch,
      }),
    ).toBe(true);
  });

  test("an errored repository preserves only its own keys even when names collide", () => {
    const stored = new Set([
      a,
      b,
      workspaceIdentityKey("/repos/a/nested", branch),
    ]);
    const unavailable = repos.map((repo, index) => ({
      ...repo,
      worktrees: [],
      ...(index === 0 ? { error: "inspection failed" } : {}),
    }));
    expect(reconcileExpandedWorkspaceKeys(stored, unavailable)).toEqual(
      new Set([a]),
    );
  });
});

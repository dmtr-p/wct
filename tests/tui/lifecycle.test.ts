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
  reconcileExpandedWorktreeKeys,
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
});

describe("LifecycleProgressRow", () => {
  // AC-10
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

    // Yellow, truncate-not-wrap: the row must stay exactly one terminal row.
    expect(hasElementProp(rendered, "color", "yellow")).toBe(true);
    expect(hasElementProp(rendered, "wrap", "truncate")).toBe(true);
    // No animation of any kind: no spinner frame, no timer.
    const text = elementText(rendered);
    expect(text.startsWith(LIFECYCLE_ROW_PREFIX)).toBe(true);
    const body = text.slice(LIFECYCLE_ROW_PREFIX.length);
    for (const spinnerFrame of ["⠋", "⠙", "⠹", "⠸", "◐", "◓", "◑", "▪"]) {
      expect(body).not.toContain(spinnerFrame);
    }
    // No elapsed timer: nothing time-derived can appear, so no digits.
    expect(/[0-9]/.test(body)).toBe(false);
    // Content is a pure function of the phase — two renders are identical.
    expect(
      elementText(
        LifecycleProgressRow({
          phase: { _tag: "RunningSetup", name: longName },
          maxWidth: 40,
        }),
      ),
    ).toBe(text);
    // Truncated to the terminal width, and the raw name never fully shown.
    expect(displayWidth(text)).toBeLessThanOrEqual(40);
    expect(text).toContain("Setup: ");
    expect(text).not.toContain(longName);
    expect(text).toContain("…");
    // The pure content helper and the component agree.
    expect(text).toBe(
      lifecycleProgressContent({ _tag: "RunningSetup", name: longName }, 40),
    );
    expect(React.isValidElement(element)).toBe(true);
  });
});

describe("forced expansion is presentation-only", () => {
  // AC-33
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

    // Presented as expanded purely from the lifecycle entry…
    expect(
      isWorktreeEffectivelyExpanded({
        expandedWorktreeKeys: stored,
        lifecycle,
        project: "alpha",
        repoPath,
        branch,
      }),
    ).toBe(true);
    // …and not once the lifecycle is gone.
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

    // The stored preference is untouched — same reference, still empty. This is
    // what keeps `reconcileExpandedWorktreeKeys` (which prunes on EVERY repos
    // change, the 5s poll included) from fighting the lifecycle.
    expect(stored.size).toBe(0);
    expect(stored.has(pendingKey("alpha", branch))).toBe(false);
    expect(reconcileExpandedWorktreeKeys(stored, repos)).toBe(stored);
    expect(reconcileExpandedWorktreeKeys(stored, [])).toBe(stored);
  });
});

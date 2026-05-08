import { describe, expect, test } from "vitest";
import { resolveStatusBarProps } from "../../src/tui/tree-helpers";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { Mode, type TreeItem } from "../../src/tui/types";

function makeRepo(project: string): RepoInfo {
  return {
    id: project,
    repoPath: `/tmp/${project}`,
    project,
    worktrees: [],
    profileNames: [],
  };
}

describe("resolveStatusBarProps", () => {
  test("marks a selected pane detail row", () => {
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane",
        label: "main:0 bash",
        meta: {
          paneId: "%1",
          zoomed: false,
          active: true,
          window: "main",
          paneIndex: 0,
          command: "bash",
        },
      },
    ];

    expect(
      resolveStatusBarProps({
        mode: Mode.Expanded("proj/branch"),
        items,
        selectedIndex: 1,
      }),
    ).toEqual({
      mode: Mode.Expanded("proj/branch"),
      selectedPaneRow: true,
      selectedProject: undefined,
    });
  });

  test("does not mark a non-pane selected row", () => {
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];

    expect(
      resolveStatusBarProps({
        mode: Mode.Expanded("proj/branch"),
        items,
        selectedIndex: 1,
      }),
    ).toEqual({
      mode: Mode.Expanded("proj/branch"),
      selectedPaneRow: false,
      selectedProject: undefined,
    });
  });

  test("passes ConfirmKill mode through unchanged", () => {
    const confirmKill = Mode.ConfirmKill("%1", "shell:1 vim", "proj/branch");

    expect(
      resolveStatusBarProps({
        mode: confirmKill,
        items: [
          { type: "repo", repoIndex: 0 },
          {
            type: "detail",
            repoIndex: 0,
            worktreeIndex: 0,
            detailKind: "pane",
            label: "main:0 bash",
            meta: {
              paneId: "%1",
              zoomed: false,
              active: true,
              window: "main",
              paneIndex: 0,
              command: "bash",
            },
          },
        ],
        selectedIndex: 1,
      }),
    ).toEqual({
      mode: confirmKill,
      selectedPaneRow: true,
      selectedProject: undefined,
    });
  });

  test("passes ConfirmDown mode through unchanged", () => {
    const confirmDown = Mode.ConfirmDown(
      "myapp-feature",
      "feature",
      "/tmp/myapp-feature",
      "proj/feature",
    );

    expect(
      resolveStatusBarProps({
        mode: confirmDown,
        items: [
          { type: "repo", repoIndex: 0 },
          { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
        ],
        selectedIndex: 1,
      }),
    ).toEqual({
      mode: confirmDown,
      selectedPaneRow: false,
      selectedProject: undefined,
    });
  });

  test("resolves selectedProject from repos when cursor is on a repo row", () => {
    const repos = [makeRepo("alpha"), makeRepo("beta")];
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "repo", repoIndex: 1 },
    ];

    expect(
      resolveStatusBarProps({
        mode: Mode.Navigate,
        items,
        selectedIndex: 1,
        repos,
      }),
    ).toEqual({
      mode: Mode.Navigate,
      selectedPaneRow: false,
      selectedProject: "beta",
    });
  });

  test("resolves selectedProject from repos when cursor is on a worktree row", () => {
    const repos = [makeRepo("myrepo")];
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];

    expect(
      resolveStatusBarProps({
        mode: Mode.Navigate,
        items,
        selectedIndex: 1,
        repos,
      }),
    ).toEqual({
      mode: Mode.Navigate,
      selectedPaneRow: false,
      selectedProject: "myrepo",
    });
  });
});

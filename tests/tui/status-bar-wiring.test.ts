import { describe, expect, test } from "vitest";
import { resolveStatusBarProps } from "../../src/tui/App";
import { Mode, type TreeItem } from "../../src/tui/types";

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
        meta: { paneId: "%1", zoomed: false, active: true },
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
            meta: { paneId: "%1", zoomed: false, active: true },
          },
        ],
        selectedIndex: 1,
      }),
    ).toEqual({
      mode: confirmKill,
      selectedPaneRow: true,
    });
  });
});

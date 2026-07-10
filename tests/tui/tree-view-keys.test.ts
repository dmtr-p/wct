import { describe, expect, test } from "vitest";
import {
  getDetailRowKey,
  getTreeElementHeights,
  getTreeElementWindow,
} from "../../src/tui/components/TreeView";
import type { TreeItem } from "../../src/tui/types";

describe("getDetailRowKey", () => {
  test("uses pane identity instead of label so duplicate pane labels do not collide", () => {
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
    } as Extract<TreeItem, { type: "detail"; detailKind: "pane" }>;
    const paneB = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane",
      label: "main:0 bash",
      meta: {
        paneId: "%2",
        zoomed: true,
        active: true,
        window: "main",
        paneIndex: 0,
        command: "bash",
      },
    } as Extract<TreeItem, { type: "detail"; detailKind: "pane" }>;

    expect(getDetailRowKey("repo-1", paneA)).toBe("detail-repo-1-0-pane-%1");
    expect(getDetailRowKey("repo-1", paneB)).toBe("detail-repo-1-0-pane-%2");
    expect(getDetailRowKey("repo-1", paneA)).not.toBe(
      getDetailRowKey("repo-1", paneB),
    );
  });

  test("keeps non-pane detail keys stable and label-based", () => {
    const prItem = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 2,
      detailKind: "pr",
      label: "PR #42",
    } as Extract<TreeItem, { type: "detail"; detailKind: "pr" }>;

    expect(getDetailRowKey("repo-1", prItem)).toBe("detail-repo-1-2-pr-PR #42");
  });
});

describe("tree element window", () => {
  test("groups secondary physical rows with their owning element", () => {
    expect(getTreeElementHeights([0, 1, 1, 2, null, null, 3])).toEqual([
      1, 2, 1, 1, 1, 1,
    ]);
  });

  test("returns only visible elements and clips viewport-edge rows locally", () => {
    expect(getTreeElementWindow([1, 2, 1, 2], 2, 3)).toEqual([
      { elementIndex: 1, height: 1, hiddenTop: 1 },
      { elementIndex: 2, height: 1, hiddenTop: 0 },
      { elementIndex: 3, height: 1, hiddenTop: 0 },
    ]);
  });

  test("returns every element when no viewport is supplied", () => {
    expect(
      getTreeElementWindow([1, 2, 1], 0, Number.POSITIVE_INFINITY),
    ).toEqual([
      { elementIndex: 0, height: 1, hiddenTop: 0 },
      { elementIndex: 1, height: 2, hiddenTop: 0 },
      { elementIndex: 2, height: 1, hiddenTop: 0 },
    ]);
  });
});

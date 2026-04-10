import { describe, expect, test } from "vitest";
import { getDetailRowKey } from "../../src/tui/components/TreeView";
import type { TreeItem } from "../../src/tui/types";

describe("getDetailRowKey", () => {
  test("uses pane identity instead of label so duplicate pane labels do not collide", () => {
    const paneA = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane",
      label: "main:0 bash",
      meta: { paneId: "%1", zoomed: false, active: false },
    } as Extract<TreeItem, { type: "detail"; detailKind: "pane" }>;
    const paneB = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane",
      label: "main:0 bash",
      meta: { paneId: "%2", zoomed: true, active: true },
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

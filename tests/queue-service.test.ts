import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  addItem,
  clearAll,
  countItems,
  formatCount,
  listItems,
  removeItem,
  removeItemsBySession,
} from "../src/services/queue";
import * as tmux from "../src/services/tmux";

describe("formatCount", () => {
  test("returns empty string for 0", () => {
    expect(formatCount(0)).toBe("");
  });

  test("returns bell emoji with count for positive number", () => {
    expect(formatCount(3)).toBe("\u{1F514} 3");
  });
});

describe("queue service", () => {
  beforeEach(() => {
    clearAll();
  });

  afterEach(() => {
    clearAll();
  });

  test("addItem returns item with generated id and timestamp", () => {
    const item = addItem({
      branch: "feature-x",
      project: "myapp",
      type: "permission_prompt",
      message: "Allow file write?",
      session: "myapp-feature-x",
      pane: "%99",
    });

    expect(item.id).toMatch(/^\d+-[a-z0-9]+$/);
    expect(item.timestamp).toBeGreaterThan(0);
    expect(item.branch).toBe("feature-x");
    expect(item.project).toBe("myapp");
  });

  test("addItem dedup - second add with same pane replaces first", () => {
    addItem({
      branch: "feature-x",
      project: "myapp",
      type: "permission_prompt",
      message: "first",
      session: "myapp-feature-x",
      pane: "%100",
    });

    addItem({
      branch: "feature-x",
      project: "myapp",
      type: "idle_prompt",
      message: "second",
      session: "myapp-feature-x",
      pane: "%100",
    });

    expect(countItems()).toBe(1);
  });

  test("countItems returns correct count after adds", () => {
    addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "s",
      pane: "%201",
    });
    addItem({
      branch: "b",
      project: "p",
      type: "t",
      message: "m",
      session: "s",
      pane: "%202",
    });

    expect(countItems()).toBe(2);
  });

  test("listItems returns items sorted by timestamp and removes stale", async () => {
    const listSessionsSpy = spyOn(tmux, "listSessions").mockResolvedValue([
      { name: "live-session", attached: false, windows: 1 },
    ]);

    try {
      addItem({
        branch: "a",
        project: "p",
        type: "t",
        message: "m",
        session: "live-session",
        pane: "%301",
      });
      addItem({
        branch: "b",
        project: "p",
        type: "t",
        message: "m",
        session: "dead-session",
        pane: "%302",
      });

      const items = await listItems();

      expect(items).toHaveLength(1);
      expect(items[0]?.session).toBe("live-session");
      // Stale item should be cleaned up from DB
      expect(countItems()).toBe(1);
    } finally {
      listSessionsSpy.mockRestore();
    }
  });

  test("listItems skips stale cleanup when all items are live", async () => {
    const listSessionsSpy = spyOn(tmux, "listSessions").mockResolvedValue([
      { name: "s1", attached: false, windows: 1 },
    ]);

    try {
      addItem({
        branch: "a",
        project: "p",
        type: "t",
        message: "m",
        session: "s1",
        pane: "%311",
      });

      const items = await listItems();

      expect(items).toHaveLength(1);
      expect(countItems()).toBe(1);
    } finally {
      listSessionsSpy.mockRestore();
    }
  });

  test("removeItem returns true for existing item", () => {
    const item = addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "s",
      pane: "%401",
    });

    expect(removeItem(item.id)).toBe(true);
    expect(countItems()).toBe(0);
  });

  test("removeItem returns false for nonexistent id", () => {
    expect(removeItem("nonexistent-id")).toBe(false);
  });

  test("removeItemsBySession removes matching items and returns count", () => {
    addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "target",
      pane: "%501",
    });
    addItem({
      branch: "b",
      project: "p",
      type: "t",
      message: "m",
      session: "target",
      pane: "%502",
    });
    addItem({
      branch: "c",
      project: "p",
      type: "t",
      message: "m",
      session: "other",
      pane: "%503",
    });

    const removed = removeItemsBySession("target");

    expect(removed).toBe(2);
    expect(countItems()).toBe(1);
  });

  test("clearAll removes everything", () => {
    addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "s",
      pane: "%601",
    });
    addItem({
      branch: "b",
      project: "p",
      type: "t",
      message: "m",
      session: "s",
      pane: "%602",
    });

    const cleared = clearAll();

    expect(cleared).toBe(2);
    expect(countItems()).toBe(0);
  });
});

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { join } from "node:path";
import { $ } from "bun";
import * as tmux from "../src/services/tmux";

const originalHome = process.env.HOME;
const testHome = join("/tmp", `wct-test-queue-${Date.now()}`);

process.env.HOME = testHome;

const {
  addItem,
  clearAll,
  formatCount,
  listItems,
  removeItem,
  removeItemsBySession,
} = await import("../src/services/queue");

describe("formatCount", () => {
  test("returns empty string for 0", () => {
    expect(formatCount(0)).toBe("");
  });

  test("returns bell emoji with count for positive number", () => {
    expect(formatCount(3)).toBe("\u{1F514} 3");
  });
});

describe("queue service", () => {
  beforeEach(async () => {
    await $`mkdir -p ${testHome}`.quiet();
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

    expect(listItems({ validatePanes: false })).resolves.toHaveLength(1);
  });

  test("listItems with pane validation disabled returns correct count after adds", async () => {
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

    await expect(listItems({ validatePanes: false })).resolves.toHaveLength(2);
  });

  test("listItems returns items sorted by timestamp and removes stale", async () => {
    const listSessionsSpy = spyOn(tmux, "listSessions").mockResolvedValue([
      { name: "live-session", attached: false, windows: 1 },
    ]);
    const isPaneAliveSpy = spyOn(tmux, "isPaneAlive").mockImplementation(
      async (pane) => pane === "%301",
    );

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
      await expect(listItems({ validatePanes: false })).resolves.toHaveLength(
        1,
      );
    } finally {
      isPaneAliveSpy.mockRestore();
      listSessionsSpy.mockRestore();
    }
  });

  test("listItems keeps entries when tmux session discovery fails", async () => {
    const listSessionsSpy = spyOn(tmux, "listSessions").mockResolvedValue(null);

    try {
      addItem({
        branch: "a",
        project: "p",
        type: "t",
        message: "m",
        session: "possibly-live-session",
        pane: "%250",
      });

      const items = await listItems();

      expect(items).toHaveLength(1);
      await expect(listItems({ validatePanes: false })).resolves.toHaveLength(
        1,
      );
    } finally {
      listSessionsSpy.mockRestore();
    }
  });

  test("listItems removes all entries when tmux has zero sessions", async () => {
    const listSessionsSpy = spyOn(tmux, "listSessions").mockResolvedValue([]);

    try {
      addItem({
        branch: "a",
        project: "p",
        type: "t",
        message: "m",
        session: "old-session",
        pane: "%251",
      });

      const items = await listItems();

      expect(items).toHaveLength(0);
      await expect(listItems({ validatePanes: false })).resolves.toHaveLength(
        0,
      );
    } finally {
      listSessionsSpy.mockRestore();
    }
  });

  test("listItems removes entries whose pane no longer exists in a live session", async () => {
    const listSessionsSpy = spyOn(tmux, "listSessions").mockResolvedValue([
      { name: "live-session", attached: false, windows: 1 },
    ]);
    const isPaneAliveSpy = spyOn(tmux, "isPaneAlive").mockImplementation(
      async (pane) => pane === "%311" || false,
    );

    try {
      addItem({
        branch: "a",
        project: "p",
        type: "t",
        message: "live",
        session: "live-session",
        pane: "%311",
      });
      addItem({
        branch: "b",
        project: "p",
        type: "t",
        message: "stale-pane",
        session: "live-session",
        pane: "%312",
      });

      const items = await listItems();

      expect(items).toHaveLength(1);
      expect(items[0]?.pane).toBe("%311");
      await expect(listItems({ validatePanes: false })).resolves.toHaveLength(
        1,
      );
    } finally {
      isPaneAliveSpy.mockRestore();
      listSessionsSpy.mockRestore();
    }
  });

  test("listItems skips stale cleanup when all items are live", async () => {
    const listSessionsSpy = spyOn(tmux, "listSessions").mockResolvedValue([
      { name: "s1", attached: false, windows: 1 },
    ]);
    const isPaneAliveSpy = spyOn(tmux, "isPaneAlive").mockResolvedValue(true);

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
      await expect(listItems({ validatePanes: false })).resolves.toHaveLength(
        1,
      );
    } finally {
      isPaneAliveSpy.mockRestore();
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
    expect(listItems({ validatePanes: false })).resolves.toHaveLength(0);
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
    expect(listItems({ validatePanes: false })).resolves.toHaveLength(1);
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
    expect(listItems({ validatePanes: false })).resolves.toHaveLength(0);
  });
});

afterAll(async () => {
  await $`rm -rf ${testHome}`.quiet();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

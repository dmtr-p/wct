import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  commandDef,
  isPaneCurrentlyVisible,
  notifyCommand,
} from "../src/commands/notify";
import * as queue from "../src/services/queue";
import { isMissingPaneError } from "../src/services/tmux";
import * as logger from "../src/utils/logger";

describe("notify commandDef", () => {
  test("has correct name", () => {
    expect(commandDef.name).toBe("notify");
  });
});

describe("notifyCommand", () => {
  let addItemSpy: ReturnType<typeof spyOn>;
  let stdinSpy: ReturnType<typeof spyOn>;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    addItemSpy = spyOn(queue, "addItem").mockReturnValue({
      id: "mock-id",
      branch: "b",
      project: "p",
      type: "t",
      message: "m",
      session: "s",
      pane: "%1",
      timestamp: 0,
    });
    // Mock Bun.stdin.text() to avoid hanging on stdin
    stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue("{}");
    savedEnv = {
      TMUX_PANE: process.env.TMUX_PANE,
      WCT_BRANCH: process.env.WCT_BRANCH,
      WCT_PROJECT: process.env.WCT_PROJECT,
    };
    // Clear env vars to test the guard
    delete process.env.TMUX_PANE;
    delete process.env.WCT_BRANCH;
    delete process.env.WCT_PROJECT;
  });

  afterEach(() => {
    addItemSpy.mockRestore();
    stdinSpy.mockRestore();
    // Restore env
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("returns ok when env vars missing", async () => {
    const result = await notifyCommand();

    expect(result.success).toBe(true);
    expect(stdinSpy).not.toHaveBeenCalled();
    expect(addItemSpy).not.toHaveBeenCalled();
  });

  test("returns ok when stdin is invalid JSON", async () => {
    stdinSpy.mockResolvedValue("not valid json");
    process.env.TMUX_PANE = "%1";
    process.env.WCT_BRANCH = "test-branch";
    process.env.WCT_PROJECT = "test-project";

    const result = await notifyCommand();

    expect(result.success).toBe(true);
    expect(addItemSpy).not.toHaveBeenCalled();
  });

  test("returns ok when only some env vars are set", async () => {
    process.env.TMUX_PANE = "%1";
    // WCT_BRANCH and WCT_PROJECT still missing

    const result = await notifyCommand();

    expect(result.success).toBe(true);
    expect(addItemSpy).not.toHaveBeenCalled();
  });

  test("returns ok and warns when queue write fails", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    addItemSpy.mockImplementation(() => {
      throw new Error("database is locked");
    });
    process.env.TMUX_PANE = "%1";
    process.env.WCT_BRANCH = "test-branch";
    process.env.WCT_PROJECT = "test-project";

    try {
      const result = await notifyCommand();

      expect(result.success).toBe(true);
      expect(addItemSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to queue notification for branch='test-branch' project='test-project' session='test-project-test-branch' pane='%1': database is locked",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("isPaneCurrentlyVisible", () => {
  test("returns true when pane is active in a visible window with attached clients", () => {
    expect(isPaneCurrentlyVisible("1:1:1")).toBe(true);
  });

  test("returns false for hidden windows even if pane is active", () => {
    expect(isPaneCurrentlyVisible("1:0:1")).toBe(false);
  });

  test("returns false when attached count is invalid", () => {
    expect(isPaneCurrentlyVisible("1:1:not-a-number")).toBe(false);
  });
});

describe("isMissingPaneError", () => {
  test("returns true for missing pane failures", () => {
    expect(isMissingPaneError(new Error("can't find pane: %1"))).toBe(true);
    expect(isMissingPaneError("no such pane")).toBe(true);
  });

  test("returns false for unrelated tmux failures", () => {
    expect(isMissingPaneError(new Error("connection refused"))).toBe(false);
  });
});

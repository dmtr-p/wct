import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { commandDef, notifyCommand } from "../src/commands/notify";
import * as queue from "../src/services/queue";

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
});

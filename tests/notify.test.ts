import { Effect } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import {
  commandDef,
  isPaneCurrentlyVisible,
  notifyCommand,
} from "../src/commands/notify";
import { runBunPromise } from "../src/effect/runtime";
import { commandError } from "../src/errors";
import {
  liveQueueStorage,
  type QueueItem,
  type QueueStorageService,
} from "../src/services/queue-storage";
import { isMissingPaneError } from "../src/services/tmux";
import * as logger from "../src/utils/logger";
import { withTestServices } from "./helpers/services";

async function runCommand(
  overrides: { queueStorage?: QueueStorageService } = {},
) {
  await runBunPromise(withTestServices(notifyCommand(), overrides));
}

describe("notify commandDef", () => {
  test("has correct name", () => {
    expect(commandDef.name).toBe("notify");
  });
});

describe("notifyCommand", () => {
  let stdinSpy: MockInstance;
  let savedEnv: Record<string, string | undefined>;
  let queueCalls: Array<Omit<QueueItem, "id" | "timestamp">>;
  let queueOverrides: QueueStorageService;

  beforeEach(() => {
    queueCalls = [];
    queueOverrides = {
      ...liveQueueStorage,
      addItem: (item) =>
        Effect.sync(() => {
          queueCalls.push(item);
          return {
            id: "mock-id",
            timestamp: 0,
            ...item,
          };
        }),
    };
    // Mock Bun.stdin.text() to avoid hanging on stdin
    stdinSpy = vi.spyOn(Bun.stdin, "text").mockResolvedValue("{}");
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
    await expect(runCommand()).resolves.toBeUndefined();
    expect(stdinSpy).not.toHaveBeenCalled();
    expect(queueCalls).toEqual([]);
  });

  test("returns ok when stdin is invalid JSON", async () => {
    stdinSpy.mockResolvedValue("not valid json");
    process.env.TMUX_PANE = "%1";
    process.env.WCT_BRANCH = "test-branch";
    process.env.WCT_PROJECT = "test-project";

    await expect(
      runCommand({ queueStorage: queueOverrides }),
    ).resolves.toBeUndefined();
    expect(queueCalls).toEqual([]);
  });

  test("returns ok when only some env vars are set", async () => {
    process.env.TMUX_PANE = "%1";
    // WCT_BRANCH and WCT_PROJECT still missing

    await expect(runCommand()).resolves.toBeUndefined();
    expect(queueCalls).toEqual([]);
  });

  test("returns ok and warns when queue write fails", async () => {
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => Effect.void);
    queueOverrides = {
      ...queueOverrides,
      addItem: () =>
        Effect.fail(commandError("queue_error", "database is locked")),
    };
    process.env.TMUX_PANE = "%1";
    process.env.WCT_BRANCH = "test-branch";
    process.env.WCT_PROJECT = "test-project";

    try {
      await expect(
        runCommand({ queueStorage: queueOverrides }),
      ).resolves.toBeUndefined();
      expect(queueCalls).toEqual([]);
      const warnMessages = warnSpy.mock.calls.map((call) =>
        String(call[0] ?? ""),
      );
      const queueWriteWarning = warnMessages.find((message) =>
        message.includes(
          "Failed to queue notification for branch='test-branch' project='test-project'",
        ),
      );

      expect(queueWriteWarning).toBeDefined();
      expect(queueWriteWarning).toContain("pane='%1': database is locked");
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

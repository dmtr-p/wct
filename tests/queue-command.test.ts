import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { JsonFlag } from "../src/cli/json-flag";
import * as queueCommandModule from "../src/commands/queue";
import { runBunPromise } from "../src/effect/runtime";
import {
  liveQueueStorage,
  type QueueItem,
  type QueueStorageService,
} from "../src/services/queue-storage";
import { withTestServices } from "./helpers/services";

const { commandDef, queueCommand, queueInternals } = queueCommandModule;

async function runCommand(
  options: queueCommandModule.QueueOptions,
  overrides: {
    queueStorage?: QueueStorageService;
  } = {},
) {
  await runBunPromise(
    withTestServices(
      Effect.provideService(queueCommand(options), JsonFlag, false),
      overrides,
    ),
  );
}

function makeItem(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    branch: "feat",
    project: "p",
    type: "t",
    message: "m",
    session: "s",
    pane: "%1",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("queue commandDef", () => {
  test("has correct name and options", () => {
    expect(commandDef.name).toBe("queue");
    expect(commandDef.options).toBeDefined();
    const optionNames = commandDef.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("dismiss");
    expect(optionNames).toContain("clear");
    expect(optionNames).toContain("jump");
  });
});

describe("queueCommand", () => {
  let queueCalls: string[];
  let queueStorage: QueueStorageService;

  beforeEach(() => {
    queueCalls = [];
    queueStorage = {
      ...liveQueueStorage,
      listItems: () => Effect.succeed([]),
      removeItem: (id: string) =>
        Effect.sync(() => {
          queueCalls.push(id);
          return true;
        }),
      clearAll: () => Effect.succeed(0),
    };
  });

  test("--dismiss valid id calls removeItem and succeeds", async () => {
    await expect(
      runCommand({ dismiss: "abc-123" }, { queueStorage }),
    ).resolves.toBeUndefined();
    expect(queueCalls).toEqual(["abc-123"]);
  });

  test("--dismiss invalid id returns queue_error", async () => {
    queueStorage = {
      ...queueStorage,
      removeItem: () => Effect.succeed(false),
    };

    await expect(
      runCommand({ dismiss: "nonexistent" }, { queueStorage }),
    ).rejects.toThrow("Queue item 'nonexistent' not found");
  });

  test("--clear calls clearAll and succeeds", async () => {
    let clearCalls = 0;
    queueStorage = {
      ...queueStorage,
      clearAll: () =>
        Effect.sync(() => {
          clearCalls += 1;
          return 5;
        }),
    };

    await expect(
      runCommand({ clear: true }, { queueStorage }),
    ).resolves.toBeUndefined();
    expect(clearCalls).toBe(1);
  });

  test("--jump with invalid id returns queue_error", async () => {
    queueStorage = {
      ...queueStorage,
      listItems: () => Effect.succeed([]),
    };

    await expect(
      runCommand({ jump: "nonexistent" }, { queueStorage }),
    ).rejects.toThrow("Queue item 'nonexistent' not found");
  });

  test("--jump with valid id but failed tmux switch returns queue_error", async () => {
    const jumpSpy = vi
      .spyOn(queueInternals, "jumpToItem")
      .mockReturnValue(Effect.succeed(false));
    queueStorage = {
      ...queueStorage,
      listItems: () =>
        Effect.succeed([makeItem("item-1", { session: "dead-session" })]),
    };

    try {
      await expect(
        runCommand({ jump: "item-1" }, { queueStorage }),
      ).rejects.toThrow("Failed to jump to session 'dead-session'");
    } finally {
      jumpSpy.mockRestore();
    }
  });

  test("default with no items returns ok", async () => {
    await expect(runCommand({}, { queueStorage })).resolves.toBeUndefined();
  });

  test("default with items lists them with formatted type and age", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    queueStorage = {
      ...queueStorage,
      listItems: () =>
        Effect.succeed([
          makeItem("test-1", {
            branch: "feature-x",
            project: "myapp",
            type: "permission_prompt",
            message: "Allow?",
            session: "myapp-feature-x",
            timestamp: Date.now() - 90_000,
          }),
          makeItem("test-2", {
            branch: "feature-y",
            project: "myapp",
            type: "idle_prompt",
            message: "Done",
            session: "myapp-feature-y",
            pane: "%2",
            timestamp: Date.now() - 5000,
          }),
        ]),
    };

    try {
      await expect(runCommand({}, { queueStorage })).resolves.toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledTimes(2);
      const call0 = consoleSpy.mock.calls[0]?.[0] as string;
      expect(call0).toContain("[permission]");
      expect(call0).toContain("1m ago");
      const call1 = consoleSpy.mock.calls[1]?.[0] as string;
      expect(call1).toContain("[question]");
      expect(call1).toContain("5s ago");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test("default with items in --json mode outputs structured JSON", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const now = Date.now();
    queueStorage = {
      ...queueStorage,
      listItems: () =>
        Effect.succeed([
          makeItem("test-1", {
            branch: "feature-x",
            project: "myapp",
            type: "permission_prompt",
            message: "Allow?",
            session: "myapp-feature-x",
            pane: "%1",
            timestamp: now - 90_000,
          }),
          makeItem("test-2", {
            branch: "feature-y",
            project: "myapp",
            type: "idle_prompt",
            message: "Done",
            session: "myapp-feature-y",
            pane: "%2",
            timestamp: now - 5000,
          }),
        ]),
    };

    try {
      await runBunPromise(
        withTestServices(
          Effect.provideService(queueCommand({}), JsonFlag, true),
          { queueStorage, json: true },
        ),
      );
      expect(consoleSpy).toHaveBeenCalledOnce();
      const firstCall = consoleSpy.mock.calls[0];
      expect(firstCall).toBeDefined();
      const output = JSON.parse(firstCall?.[0] as string);
      expect(output.ok).toBe(true);
      expect(output.data).toHaveLength(2);
      expect(output.data[0]).toEqual({
        id: "test-1",
        type: "permission_prompt",
        project: "myapp",
        branch: "feature-x",
        session: "myapp-feature-x",
        pane: "%1",
        timestamp: now - 90_000,
        message: "Allow?",
      });
      expect(output.data[1].id).toBe("test-2");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test("default with no items in --json mode outputs empty array", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runBunPromise(
        withTestServices(
          Effect.provideService(queueCommand({}), JsonFlag, true),
          { queueStorage, json: true },
        ),
      );
      expect(consoleSpy).toHaveBeenCalledOnce();
      const firstCall = consoleSpy.mock.calls[0];
      expect(firstCall).toBeDefined();
      const output = JSON.parse(firstCall?.[0] as string);
      expect(output).toEqual({ ok: true, data: [] });
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

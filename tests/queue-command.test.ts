import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
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
  await runBunPromise(withTestServices(queueCommand(options), overrides));
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
    expect(optionNames).toContain("count");
    expect(optionNames).toContain("dismiss");
    expect(optionNames).toContain("clear");
    expect(optionNames).toContain("jump");
    expect(optionNames).toContain("interactive");
  });
});

describe("queueCommand", () => {
  let queueCalls: string[];
  let queueStorage: QueueStorageService;
  let stdoutWriteSpy: ReturnType<typeof spyOn>;

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
    stdoutWriteSpy = spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  test("--count with 0 items writes nothing to stdout", async () => {
    queueStorage = {
      ...queueStorage,
      listItems: () => Effect.succeed([]),
    };

    await expect(
      runCommand({ count: true }, { queueStorage }),
    ).resolves.toBeUndefined();
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
  });

  test("--count with items writes formatted count", async () => {
    queueStorage = {
      ...queueStorage,
      listItems: () =>
        Effect.succeed([
          makeItem("item-1"),
          makeItem("item-2", { pane: "%2" }),
          makeItem("item-3", { pane: "%3" }),
        ]),
    };

    await expect(
      runCommand({ count: true }, { queueStorage }),
    ).resolves.toBeUndefined();
    expect(stdoutWriteSpy).toHaveBeenCalledWith("\u{1F514} 3");
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
    const jumpSpy = spyOn(queueInternals, "jumpToItem").mockReturnValue(
      Effect.succeed(false),
    );
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
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
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
});

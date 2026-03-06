import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as queueCommandModule from "../src/commands/queue";
import * as queueService from "../src/services/queue";

const { commandDef, queueCommand, queueInternals } = queueCommandModule;

interface QueueCommandSpies {
  countItemsSpy: ReturnType<typeof spyOn<typeof queueService, "countItems">>;
  formatCountSpy: ReturnType<typeof spyOn<typeof queueService, "formatCount">>;
  listItemsSpy: ReturnType<typeof spyOn<typeof queueService, "listItems">>;
  removeItemSpy: ReturnType<typeof spyOn<typeof queueService, "removeItem">>;
  clearAllSpy: ReturnType<typeof spyOn<typeof queueService, "clearAll">>;
  stdoutWriteSpy: ReturnType<typeof spyOn>;
  restore: () => void;
}

function setupMocks(): QueueCommandSpies {
  const countItemsSpy = spyOn(queueService, "countItems").mockReturnValue(0);
  const formatCountSpy = spyOn(queueService, "formatCount").mockReturnValue("");
  const listItemsSpy = spyOn(queueService, "listItems").mockResolvedValue([]);
  const removeItemSpy = spyOn(queueService, "removeItem").mockReturnValue(true);
  const clearAllSpy = spyOn(queueService, "clearAll").mockReturnValue(0);
  const stdoutWriteSpy = spyOn(process.stdout, "write").mockReturnValue(true);

  return {
    countItemsSpy,
    formatCountSpy,
    listItemsSpy,
    removeItemSpy,
    clearAllSpy,
    stdoutWriteSpy,
    restore: () => {
      countItemsSpy.mockRestore();
      formatCountSpy.mockRestore();
      listItemsSpy.mockRestore();
      removeItemSpy.mockRestore();
      clearAllSpy.mockRestore();
      stdoutWriteSpy.mockRestore();
    },
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
  let mocks: QueueCommandSpies;

  beforeEach(() => {
    mocks = setupMocks();
  });

  afterEach(() => {
    mocks.restore();
  });

  test("--count with 0 items writes nothing to stdout", async () => {
    mocks.countItemsSpy.mockReturnValue(0);
    mocks.formatCountSpy.mockReturnValue("");

    const result = await queueCommand({ count: true });

    expect(result.success).toBe(true);
    expect(mocks.stdoutWriteSpy).not.toHaveBeenCalled();
  });

  test("--count with items writes formatted count", async () => {
    mocks.countItemsSpy.mockReturnValue(3);
    mocks.formatCountSpy.mockReturnValue("\u{1F514} 3");

    const result = await queueCommand({ count: true });

    expect(result.success).toBe(true);
    expect(mocks.stdoutWriteSpy).toHaveBeenCalledWith("\u{1F514} 3");
  });

  test("--dismiss valid id calls removeItem and succeeds", async () => {
    mocks.removeItemSpy.mockReturnValue(true);

    const result = await queueCommand({ dismiss: "abc-123" });

    expect(result.success).toBe(true);
    expect(mocks.removeItemSpy).toHaveBeenCalledWith("abc-123");
  });

  test("--dismiss invalid id returns queue_error", async () => {
    mocks.removeItemSpy.mockReturnValue(false);

    const result = await queueCommand({ dismiss: "nonexistent" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("queue_error");
    }
  });

  test("--clear calls clearAll and succeeds", async () => {
    mocks.clearAllSpy.mockReturnValue(5);

    const result = await queueCommand({ clear: true });

    expect(result.success).toBe(true);
    expect(mocks.clearAllSpy).toHaveBeenCalled();
  });

  test("--jump with invalid id returns queue_error", async () => {
    mocks.listItemsSpy.mockResolvedValue([]);

    const result = await queueCommand({ jump: "nonexistent" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("queue_error");
    }
  });

  test("--jump with valid id but failed tmux switch returns queue_error", async () => {
    const jumpSpy = spyOn(queueInternals, "jumpToItem").mockResolvedValue(
      false,
    );
    mocks.listItemsSpy.mockResolvedValue([
      {
        id: "item-1",
        branch: "feat",
        project: "p",
        type: "t",
        message: "m",
        session: "dead-session",
        pane: "%1",
        timestamp: Date.now(),
      },
    ]);

    try {
      const result = await queueCommand({ jump: "item-1" });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("queue_error");
      }
    } finally {
      jumpSpy.mockRestore();
    }
  });

  test("default with no items returns ok", async () => {
    mocks.listItemsSpy.mockResolvedValue([]);

    const result = await queueCommand({});

    expect(result.success).toBe(true);
  });

  test("default with items lists them with formatted type and age", async () => {
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      mocks.listItemsSpy.mockResolvedValue([
        {
          id: "test-1",
          branch: "feature-x",
          project: "myapp",
          type: "permission_prompt",
          message: "Allow?",
          session: "myapp-feature-x",
          pane: "%1",
          timestamp: Date.now() - 90_000, // 90 seconds ago
        },
        {
          id: "test-2",
          branch: "feature-y",
          project: "myapp",
          type: "idle_prompt",
          message: "Done",
          session: "myapp-feature-y",
          pane: "%2",
          timestamp: Date.now() - 5000, // 5 seconds ago
        },
      ]);

      const result = await queueCommand({});

      expect(result.success).toBe(true);
      expect(consoleSpy).toHaveBeenCalledTimes(2);
      // formatType maps permission_prompt -> permission, idle_prompt -> question
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

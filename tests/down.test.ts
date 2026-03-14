import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { downCommand } from "../src/commands/down";
import { runBunPromise } from "../src/effect/runtime";
import { commandError } from "../src/errors";
import {
  liveQueueStorage,
  type QueueStorageService,
} from "../src/services/queue-storage";
import {
  formatSessionName,
  liveTmuxService,
  type TmuxService,
} from "../src/services/tmux";
import {
  liveWorktreeService,
  type WorktreeService,
} from "../src/services/worktree-service";
import * as logger from "../src/utils/logger";
import { withTestServices } from "./helpers/services";

async function runCommand(
  overrides: {
    queueStorage?: QueueStorageService;
    tmux?: TmuxService;
    worktree?: WorktreeService;
  } = {},
) {
  await runBunPromise(withTestServices(downCommand(), overrides));
}

describe("downCommand", () => {
  test("is exported as a function", () => {
    expect(typeof downCommand).toBe("function");
  });
});

describe("down session name derivation", () => {
  test("derives session name from directory basename", () => {
    const sessionName = formatSessionName("myapp-feature-auth");
    expect(sessionName).toBe("myapp-feature-auth");
  });

  test("sanitizes special characters in dirname", () => {
    const sessionName = formatSessionName("myapp.feature");
    expect(sessionName).toBe("myapp-feature");
  });
});

describe("downCommand behavior", () => {
  let cwdSpy: ReturnType<typeof spyOn<typeof process, "cwd">>;
  let queueCalls: string[];
  let tmuxOverrides: TmuxService;
  let worktreeOverrides: WorktreeService;
  let queueOverrides: QueueStorageService;

  beforeEach(() => {
    cwdSpy = spyOn(process, "cwd").mockReturnValue("/tmp/myapp-feature-auth");
    queueCalls = [];
    worktreeOverrides = {
      ...liveWorktreeService,
      isGitRepo: () => Effect.succeed(true),
    };
    tmuxOverrides = {
      ...liveTmuxService,
      sessionExists: () => Effect.succeed(true),
      killSession: () => Effect.succeed(undefined),
    };
    queueOverrides = {
      ...liveQueueStorage,
      removeItemsBySession: (session: string) =>
        Effect.sync(() => {
          queueCalls.push(session);
          return 0;
        }),
    };
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  test("removes queue items only after a successful kill", async () => {
    const callOrder: string[] = [];
    tmuxOverrides = {
      ...tmuxOverrides,
      killSession: () =>
        Effect.sync(() => {
          callOrder.push("kill");
        }),
    };
    queueOverrides = {
      ...queueOverrides,
      removeItemsBySession: (session) =>
        Effect.sync(() => {
          callOrder.push("queue");
          queueCalls.push(session);
          return 0;
        }),
    };

    await expect(
      runCommand({
        tmux: tmuxOverrides,
        queueStorage: queueOverrides,
        worktree: worktreeOverrides,
      }),
    ).resolves.toBeUndefined();
    expect(queueCalls).toEqual(["myapp-feature-auth"]);
    expect(callOrder).toEqual(["kill", "queue"]);
  });

  test("does not remove queue items when killSession fails", async () => {
    tmuxOverrides = {
      ...tmuxOverrides,
      killSession: () => Effect.fail(commandError("tmux_error", "tmux failed")),
    };

    await expect(
      runCommand({
        tmux: tmuxOverrides,
        queueStorage: queueOverrides,
        worktree: worktreeOverrides,
      }),
    ).rejects.toThrow("tmux failed");
    expect(queueCalls).toEqual([]);
  });

  test("warns and succeeds when queue cleanup fails after kill", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => Effect.void);
    queueOverrides = {
      ...queueOverrides,
      removeItemsBySession: () =>
        Effect.fail(commandError("queue_error", "queue locked")),
    };

    try {
      await expect(
        runCommand({
          tmux: tmuxOverrides,
          queueStorage: queueOverrides,
          worktree: worktreeOverrides,
        }),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to clean queue entries"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

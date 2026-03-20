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
import { closeCommand, commandDef } from "../src/commands/close";
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
import * as prompt from "../src/utils/prompt";
import { withTestServices } from "./helpers/services";

async function runCommand(
  options: {
    branches: string[];
    yes?: boolean;
    force?: boolean;
  },
  overrides: {
    queueStorage?: QueueStorageService;
    tmux?: TmuxService;
    worktree?: WorktreeService;
  } = {},
) {
  await runBunPromise(withTestServices(closeCommand(options), overrides));
}

interface CloseCommandSpies {
  confirmSpy: MockInstance;
  queueCalls: string[];
  tmuxCalls: string[];
  worktreeCalls: string[];
  tmux: TmuxService;
  worktree: WorktreeService;
  queueStorage: QueueStorageService;
  restore: () => void;
}

function makeWorktree(branch: string) {
  return {
    path: `/tmp/myapp-${branch}`,
    branch,
    commit: "abc123",
    isBare: false,
  };
}

function setupMocks(): CloseCommandSpies {
  const confirmSpy = vi
    .spyOn(prompt, "confirm")
    .mockImplementation(() => Effect.succeed(true));
  const queueCalls: string[] = [];
  const tmuxCalls: string[] = [];
  const worktreeCalls: string[] = [];
  const tmux = {
    ...liveTmuxService,
    getCurrentSession: () => Effect.succeed(null),
    sessionExists: () => Effect.succeed(true),
    killSession: (name: string) =>
      Effect.sync(() => {
        tmuxCalls.push(name);
      }),
  };
  const worktree = {
    ...liveWorktreeService,
    isGitRepo: () => Effect.succeed(true),
    findWorktreeByBranch: (branch: string) =>
      Effect.succeed(makeWorktree(branch)),
    removeWorktree: (path: string) =>
      Effect.sync(() => {
        worktreeCalls.push(path);
        return { _tag: "Removed" as const, path };
      }),
  };
  const queueStorage = {
    ...liveQueueStorage,
    removeItemsBySession: (session: string) =>
      Effect.sync(() => {
        queueCalls.push(session);
        return 0;
      }),
  };

  return {
    confirmSpy,
    queueCalls,
    tmuxCalls,
    worktreeCalls,
    tmux,
    worktree,
    queueStorage,
    restore: () => {
      confirmSpy.mockRestore();
    },
  };
}

describe("closeCommand", () => {
  let mocks: CloseCommandSpies;

  beforeEach(() => {
    mocks = setupMocks();
  });

  afterEach(() => {
    mocks.restore();
  });

  test("is exported as a function", () => {
    expect(typeof closeCommand).toBe("function");
  });

  test("closes multiple branches in order", async () => {
    await expect(
      runCommand(
        {
          branches: ["feature-a", "feature-b"],
        },
        {
          tmux: mocks.tmux,
          worktree: mocks.worktree,
          queueStorage: mocks.queueStorage,
        },
      ),
    ).resolves.toBeUndefined();
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(2);
    expect(mocks.tmuxCalls).toEqual([
      formatSessionName("myapp-feature-a"),
      formatSessionName("myapp-feature-b"),
    ]);
    expect(mocks.worktreeCalls).toEqual([
      "/tmp/myapp-feature-a",
      "/tmp/myapp-feature-b",
    ]);
  });

  test("stops on first missing branch in multi-close", async () => {
    mocks.worktree = {
      ...mocks.worktree,
      findWorktreeByBranch: (branch: string) =>
        Effect.succeed(branch === "missing" ? null : makeWorktree(branch)),
    };

    await expect(
      runCommand(
        {
          branches: ["feature-a", "missing", "feature-c"],
        },
        {
          tmux: mocks.tmux,
          worktree: mocks.worktree,
          queueStorage: mocks.queueStorage,
        },
      ),
    ).rejects.toThrow("No worktree found for branch 'missing'");
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(1);
    expect(mocks.tmuxCalls).toHaveLength(1);
    expect(mocks.worktreeCalls).toHaveLength(1);
  });

  test("stops on first remove failure", async () => {
    mocks.worktree = {
      ...mocks.worktree,
      removeWorktree: (path: string) =>
        Effect.sync(() => {
          mocks.worktreeCalls.push(path);
          if (path.endsWith("feature-b")) {
            return { _tag: "BlockedByChanges" as const, path };
          }
          return { _tag: "Removed" as const, path };
        }),
    };

    await expect(
      runCommand(
        {
          branches: ["feature-a", "feature-b", "feature-c"],
        },
        {
          tmux: mocks.tmux,
          worktree: mocks.worktree,
          queueStorage: mocks.queueStorage,
        },
      ),
    ).rejects.toThrow("Use --force");
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(2);
    expect(mocks.tmuxCalls).toHaveLength(2);
    expect(mocks.worktreeCalls).toHaveLength(2);
  });

  test("skips confirmations for all branches with --yes", async () => {
    mocks.tmux = {
      ...mocks.tmux,
      getCurrentSession: () => Effect.succeed("myapp-feature-a"),
    };

    await expect(
      runCommand(
        {
          branches: ["feature-a", "feature-b"],
          yes: true,
        },
        {
          tmux: mocks.tmux,
          worktree: mocks.worktree,
          queueStorage: mocks.queueStorage,
        },
      ),
    ).resolves.toBeUndefined();
    expect(mocks.confirmSpy).not.toHaveBeenCalled();
    expect(mocks.tmuxCalls).toHaveLength(2);
    expect(mocks.worktreeCalls).toHaveLength(2);
  });

  test("defers current tmux session branch until last in multi-close", async () => {
    const prompts: string[] = [];
    mocks.confirmSpy.mockImplementation((message: string) => {
      prompts.push(message);
      return Effect.succeed(true);
    });
    mocks.tmux = {
      ...mocks.tmux,
      getCurrentSession: () => Effect.succeed("myapp-feature-a"),
    };

    await expect(
      runCommand(
        {
          branches: ["feature-a", "feature-b"],
        },
        {
          tmux: mocks.tmux,
          worktree: mocks.worktree,
          queueStorage: mocks.queueStorage,
        },
      ),
    ).resolves.toBeUndefined();
    expect(mocks.tmuxCalls).toEqual(["myapp-feature-b", "myapp-feature-a"]);
    expect(mocks.worktreeCalls).toEqual([
      "/tmp/myapp-feature-b",
      "/tmp/myapp-feature-a",
    ]);
    expect(prompts[0]).toContain("feature-b");
    expect(prompts[1]).toContain("feature-a");
    expect(prompts[2]).toContain("inside this tmux session");
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(3);
  });

  test("removes queue items only after a successful session kill", async () => {
    await expect(
      runCommand(
        {
          branches: ["feature-a"],
          yes: true,
        },
        {
          tmux: mocks.tmux,
          worktree: mocks.worktree,
          queueStorage: mocks.queueStorage,
        },
      ),
    ).resolves.toBeUndefined();
    expect(mocks.tmuxCalls).toEqual(["myapp-feature-a"]);
    expect(mocks.queueCalls).toEqual(["myapp-feature-a"]);
  });

  test("does not remove queue items when killSession fails", async () => {
    mocks.tmux = {
      ...mocks.tmux,
      killSession: () => Effect.fail(commandError("tmux_error", "tmux failed")),
    };

    await expect(
      runCommand(
        {
          branches: ["feature-a"],
          yes: true,
        },
        {
          tmux: mocks.tmux,
          worktree: mocks.worktree,
          queueStorage: mocks.queueStorage,
        },
      ),
    ).resolves.toBeUndefined();
    expect(mocks.queueCalls).toEqual([]);
  });

  test("warns separately when queue cleanup fails after tmux kill", async () => {
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => Effect.void);
    mocks.queueStorage = {
      ...mocks.queueStorage,
      removeItemsBySession: () =>
        Effect.fail(commandError("queue_error", "queue locked")),
    };

    try {
      await expect(
        runCommand(
          {
            branches: ["feature-a"],
            yes: true,
          },
          {
            tmux: mocks.tmux,
            worktree: mocks.worktree,
            queueStorage: mocks.queueStorage,
          },
        ),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to clean queue entries"),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill tmux session"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("close commandDef", () => {
  test("uses variadic branch args", () => {
    expect(commandDef.args).toBe("<branch...>");
  });
});

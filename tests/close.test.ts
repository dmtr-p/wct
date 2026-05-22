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
import { formatSessionName, type TmuxService } from "../src/services/tmux";
import type {
  WorkspaceCloseResult,
  WorkspaceService,
} from "../src/services/workspace-service";
import {
  liveWorktreeService,
  type WorktreeService,
} from "../src/services/worktree-service";
import * as prompt from "../src/utils/prompt";
import { noopTmuxService, withTestServices } from "./helpers/services";

async function runCommand(
  options: {
    branches: string[];
    yes?: boolean;
    force?: boolean;
  },
  overrides: {
    json?: boolean;
    tmux?: TmuxService;
    worktree?: WorktreeService;
    workspace?: WorkspaceService;
  } = {},
) {
  await runBunPromise(withTestServices(closeCommand(options), overrides));
}

interface CloseCommandSpies {
  confirmSpy: MockInstance;
  tmuxCalls: string[];
  worktreeCalls: string[];
  tmux: TmuxService;
  worktree: WorktreeService;
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

function removedCloseResult(branch: string): WorkspaceCloseResult {
  const worktreePath = `/tmp/myapp-${branch}`;
  return {
    operation: "close",
    worktreePath,
    sessionName: formatSessionName(`myapp-${branch}`),
    existed: true,
    status: "removed",
    attempts: {
      kill: { attempted: true, ok: true, value: null },
      remove: {
        attempted: true,
        ok: true,
        value: { _tag: "Removed", path: worktreePath },
      },
    },
    warnings: [],
  };
}

function setupMocks(): CloseCommandSpies {
  const confirmSpy = vi
    .spyOn(prompt, "confirm")
    .mockImplementation(() => Effect.succeed(true));
  const tmuxCalls: string[] = [];
  const worktreeCalls: string[] = [];
  const tmux = {
    ...noopTmuxService,
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

  return {
    confirmSpy,
    tmuxCalls,
    worktreeCalls,
    tmux,
    worktree,
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

  test("calls WorkspaceService.close once per branch in loop order", async () => {
    const closeCalls: unknown[] = [];
    const workspace: WorkspaceService = {
      open: () => Effect.die("unused"),
      up: () => Effect.die("unused"),
      down: () => Effect.die("unused"),
      close: (options) =>
        Effect.sync(() => {
          closeCalls.push(options);
          return removedCloseResult("feature-a");
        }),
    };

    await runCommand(
      {
        branches: ["feature-a", "feature-b"],
        yes: true,
      },
      {
        tmux: mocks.tmux,
        worktree: mocks.worktree,
        workspace,
      },
    );

    expect(closeCalls).toEqual([
      { path: "/tmp/myapp-feature-a", force: false },
      { path: "/tmp/myapp-feature-b", force: false },
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
        },
      ),
    ).rejects.toThrow("No worktree found for branch 'missing'");
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(1);
    expect(mocks.tmuxCalls).toHaveLength(1);
    expect(mocks.worktreeCalls).toHaveLength(1);
  });

  test("prompts to force remove when worktree has changes", async () => {
    let forceRemoveCalled = false;
    mocks.worktree = {
      ...mocks.worktree,
      removeWorktree: (path: string, force?: boolean) =>
        Effect.sync(() => {
          mocks.worktreeCalls.push(path);
          if (path.endsWith("feature-b") && !force) {
            return { _tag: "BlockedByChanges" as const, path };
          }
          if (path.endsWith("feature-b") && force) {
            forceRemoveCalled = true;
          }
          return { _tag: "Removed" as const, path };
        }),
    };

    await runCommand(
      {
        branches: ["feature-a", "feature-b", "feature-c"],
      },
      {
        tmux: mocks.tmux,
        worktree: mocks.worktree,
      },
    );
    // 3 branch confirmations + 1 force-remove confirmation
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(4);
    expect(mocks.confirmSpy).toHaveBeenCalledWith(
      "Worktree has uncommitted changes. Force remove anyway?",
    );
    expect(forceRemoveCalled).toBe(true);
    expect(mocks.tmuxCalls).toHaveLength(4);
    // feature-a, feature-b (blocked), feature-b (force), feature-c
    expect(mocks.worktreeCalls).toHaveLength(4);
  });

  test("keeps force prompt policy outside WorkspaceService", async () => {
    const closeCalls: unknown[] = [];
    const workspace: WorkspaceService = {
      open: () => Effect.die("unused"),
      up: () => Effect.die("unused"),
      down: () => Effect.die("unused"),
      close: (options) =>
        Effect.sync(() => {
          closeCalls.push(options);
          const branch = options?.path?.endsWith("feature-a")
            ? "feature-a"
            : "unknown";
          if (!options?.force) {
            return {
              ...removedCloseResult(branch),
              status: "blocked_by_changes" as const,
              attempts: {
                kill: {
                  attempted: true as const,
                  ok: true as const,
                  value: null,
                },
                remove: {
                  attempted: true as const,
                  ok: true as const,
                  value: {
                    _tag: "BlockedByChanges" as const,
                    path: "/tmp/myapp-feature-a",
                  },
                },
              },
            };
          }
          return removedCloseResult(branch);
        }),
    };

    await runCommand(
      {
        branches: ["feature-a"],
      },
      {
        tmux: mocks.tmux,
        worktree: mocks.worktree,
        workspace,
      },
    );

    expect(mocks.confirmSpy).toHaveBeenCalledWith(
      "Worktree has uncommitted changes. Force remove anyway?",
    );
    expect(closeCalls).toEqual([
      { path: "/tmp/myapp-feature-a", force: false },
      { path: "/tmp/myapp-feature-a", force: true },
    ]);
  });

  test("JSON preserves first-call kill result when force retry removes dirty worktree", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const closeCalls: unknown[] = [];
    const workspace: WorkspaceService = {
      open: () => Effect.die("unused"),
      up: () => Effect.die("unused"),
      down: () => Effect.die("unused"),
      close: (options) =>
        Effect.sync(() => {
          closeCalls.push(options);
          const branch = options?.path?.endsWith("feature-a")
            ? "feature-a"
            : "unknown";
          const worktreePath = `/tmp/myapp-${branch}`;
          if (!options?.force) {
            return {
              ...removedCloseResult(branch),
              status: "blocked_by_changes" as const,
              attempts: {
                kill: {
                  attempted: true as const,
                  ok: true as const,
                  value: null,
                },
                remove: {
                  attempted: true as const,
                  ok: true as const,
                  value: {
                    _tag: "BlockedByChanges" as const,
                    path: worktreePath,
                  },
                },
              },
            };
          }

          return {
            ...removedCloseResult(branch),
            existed: false,
            attempts: {
              kill: {
                attempted: false as const,
                reason: "session_absent",
              },
              remove: {
                attempted: true as const,
                ok: true as const,
                value: { _tag: "Removed" as const, path: worktreePath },
              },
            },
          };
        }),
    };

    try {
      await runCommand(
        {
          branches: ["feature-a"],
          yes: true,
        },
        {
          json: true,
          tmux: mocks.tmux,
          worktree: mocks.worktree,
          workspace,
        },
      );

      expect(closeCalls).toEqual([
        { path: "/tmp/myapp-feature-a", force: false },
        { path: "/tmp/myapp-feature-a", force: true },
      ]);
      const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
      expect(output.data[0]).toMatchObject({
        operation: "close",
        status: "removed",
        existed: true,
        attempts: {
          kill: { attempted: true, ok: true, value: null },
          remove: {
            attempted: true,
            ok: true,
            value: { _tag: "Removed", path: "/tmp/myapp-feature-a" },
          },
        },
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("aborts when user declines force remove", async () => {
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
    // Accept first two confirmations, decline the force-remove prompt
    mocks.confirmSpy
      .mockImplementationOnce(() => Effect.succeed(true))
      .mockImplementationOnce(() => Effect.succeed(true))
      .mockImplementationOnce(() => Effect.succeed(false));

    await runCommand(
      {
        branches: ["feature-a", "feature-b", "feature-c"],
      },
      {
        tmux: mocks.tmux,
        worktree: mocks.worktree,
      },
    );
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(3);
    expect(mocks.tmuxCalls).toHaveLength(2);
    expect(mocks.worktreeCalls).toHaveLength(2);
  });

  test("skips force-remove prompt with --force on dirty worktree", async () => {
    let forceArg = false;
    mocks.worktree = {
      ...mocks.worktree,
      removeWorktree: (path: string, force?: boolean) =>
        Effect.sync(() => {
          mocks.worktreeCalls.push(path);
          if (force) {
            forceArg = true;
          }
          return { _tag: "Removed" as const, path };
        }),
    };

    await runCommand(
      {
        branches: ["feature-a"],
        force: true,
      },
      {
        tmux: mocks.tmux,
        worktree: mocks.worktree,
      },
    );
    // --force skips the dirty-worktree prompt (only the branch confirmation remains)
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(1);
    expect(mocks.confirmSpy).not.toHaveBeenCalledWith(
      "Worktree has uncommitted changes. Force remove anyway?",
    );
    expect(forceArg).toBe(true);
    expect(mocks.worktreeCalls).toHaveLength(1);
  });

  test("skips force-remove prompt with --yes on dirty worktree", async () => {
    let forceRemoveCalled = false;
    mocks.worktree = {
      ...mocks.worktree,
      removeWorktree: (path: string, force?: boolean) =>
        Effect.sync(() => {
          mocks.worktreeCalls.push(path);
          if (path.endsWith("feature-a") && !force) {
            return { _tag: "BlockedByChanges" as const, path };
          }
          if (path.endsWith("feature-a") && force) {
            forceRemoveCalled = true;
          }
          return { _tag: "Removed" as const, path };
        }),
    };

    await runCommand(
      {
        branches: ["feature-a"],
        yes: true,
      },
      {
        tmux: mocks.tmux,
        worktree: mocks.worktree,
      },
    );
    expect(mocks.confirmSpy).not.toHaveBeenCalled();
    expect(forceRemoveCalled).toBe(true);
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
        },
      ),
    ).resolves.toBeUndefined();
    expect(mocks.confirmSpy).not.toHaveBeenCalled();
    expect(mocks.tmuxCalls).toHaveLength(2);
    expect(mocks.worktreeCalls).toHaveLength(2);
  });

  test("json output emits final close results only", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const workspace: WorkspaceService = {
      open: () => Effect.die("unused"),
      up: () => Effect.die("unused"),
      down: () => Effect.die("unused"),
      close: (options) =>
        Effect.succeed(
          removedCloseResult(
            options?.path?.endsWith("feature-a") ? "feature-a" : "feature-b",
          ),
        ),
    };

    try {
      await runCommand(
        {
          branches: ["feature-a", "feature-b"],
          yes: true,
        },
        {
          json: true,
          tmux: mocks.tmux,
          worktree: mocks.worktree,
          workspace,
        },
      );

      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
      expect(output).toEqual({
        ok: true,
        data: [
          removedCloseResult("feature-a"),
          removedCloseResult("feature-b"),
        ],
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("human output keeps final session and removal messages", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const workspace: WorkspaceService = {
      open: () => Effect.die("unused"),
      up: () => Effect.die("unused"),
      down: () => Effect.die("unused"),
      close: (options) =>
        Effect.succeed({
          ...removedCloseResult(
            options?.path?.endsWith("feature-a") ? "feature-a" : "feature-b",
          ),
          existed: !options?.path?.endsWith("feature-b"),
          attempts: {
            kill: options?.path?.endsWith("feature-b")
              ? { attempted: false as const, reason: "session_absent" }
              : { attempted: true as const, ok: true as const, value: null },
            remove: removedCloseResult(
              options?.path?.endsWith("feature-a") ? "feature-a" : "feature-b",
            ).attempts.remove,
          },
        }),
    };

    try {
      await runCommand(
        {
          branches: ["feature-a", "feature-b"],
          yes: true,
        },
        {
          tmux: mocks.tmux,
          worktree: mocks.worktree,
          workspace,
        },
      );

      const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(
        loggedLines.some((line) =>
          line.includes("Killed tmux session 'myapp-feature-a'"),
        ),
      ).toBe(true);
      expect(
        loggedLines.some((line) =>
          line.includes("No tmux session 'myapp-feature-b' found"),
        ),
      ).toBe(true);
      expect(
        loggedLines.some((line) =>
          line.includes("Removed worktree 'feature-a'"),
        ),
      ).toBe(true);
      expect(
        loggedLines.some((line) =>
          line.includes("Removed worktree 'feature-b'"),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("WorkspaceService.close failure aborts branch loop without human success output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const closeCalls: unknown[] = [];
    const workspace: WorkspaceService = {
      open: () => Effect.die("unused"),
      up: () => Effect.die("unused"),
      down: () => Effect.die("unused"),
      close: (options) =>
        Effect.sync(() => {
          closeCalls.push(options);
          if (options?.path === "/tmp/myapp-feature-a") {
            throw new Error("kill boom");
          }
          return removedCloseResult("unknown");
        }),
    };

    try {
      await expect(
        runCommand(
          {
            branches: ["feature-a", "feature-b"],
            yes: true,
          },
          {
            tmux: mocks.tmux,
            worktree: mocks.worktree,
            workspace,
          },
        ),
      ).rejects.toThrow("kill boom");

      expect(closeCalls).toEqual([
        { path: "/tmp/myapp-feature-a", force: false },
      ]);
      const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(
        loggedLines.some((line) => line.includes("Killed tmux session")),
      ).toBe(false);
      expect(
        loggedLines.some((line) => line.includes("Removed worktree")),
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("WorkspaceService.close failure emits no JSON success result", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const closeCalls: unknown[] = [];
    const workspace: WorkspaceService = {
      open: () => Effect.die("unused"),
      up: () => Effect.die("unused"),
      down: () => Effect.die("unused"),
      close: (options) =>
        Effect.sync(() => {
          closeCalls.push(options);
          if (options?.path === "/tmp/myapp-feature-a") {
            throw new Error("kill boom");
          }
          return removedCloseResult("unknown");
        }),
    };

    try {
      await expect(
        runCommand(
          {
            branches: ["feature-a", "feature-b"],
            yes: true,
          },
          {
            json: true,
            tmux: mocks.tmux,
            worktree: mocks.worktree,
            workspace,
          },
        ),
      ).rejects.toThrow("kill boom");

      expect(closeCalls).toEqual([
        { path: "/tmp/myapp-feature-a", force: false },
      ]);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
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
});

describe("close commandDef", () => {
  test("uses variadic branch args", () => {
    expect(commandDef.args).toBe("<branch...>");
  });
});

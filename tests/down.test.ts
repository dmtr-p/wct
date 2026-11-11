import { Effect } from "effect";
import { Command } from "effect/cli";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import { rootCommand } from "../src/cli/root-command";
import { downCommand, type DownOptions } from "../src/commands/down";
import { runBunPromise } from "../src/effect/runtime";
import { commandError } from "../src/errors";
import type { WorkspaceSessionTarget } from "../src/services/session-identity";
import { formatSessionName, type TmuxService } from "../src/services/tmux";
import type { WorkspaceService } from "../src/services/workspace-service";
import type { WorktreeServiceImplementation as WorktreeService } from "../src/services/worktree-service";
import {
  legacySession,
  noopTmuxService,
  shutdownWorktreeService,
  withTestServices,
} from "./helpers/services";

async function runCommand(
  options?: DownOptions,
  overrides: {
    json?: boolean;
    tmux?: TmuxService;
    worktree?: WorktreeService;
    workspace?: WorkspaceService;
  } = {},
) {
  await runBunPromise(withTestServices(downCommand(options), overrides));
}

async function runRootCommand(
  args: string[],
  overrides: { tmux?: TmuxService; worktree?: WorktreeService } = {},
) {
  await runBunPromise(
    withTestServices(
      Command.runWith(rootCommand, { version: "1.0.0" })(args),
      overrides,
    ),
  );
}

describe("downCommand", () => {
  test("is exported as a function", () => {
    expect(typeof downCommand).toBe("function");
  });
});

describe("down readable session prefix", () => {
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
  let cwdSpy: MockInstance;
  let tmuxOverrides: TmuxService;
  let worktreeOverrides: WorktreeService;

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/outside-git-repo");
    worktreeOverrides = {
      ...shutdownWorktreeService,
      isGitRepo: () => Effect.succeed(true),
      findWorktreeByBranch: () => Effect.succeed(null),
    };
    tmuxOverrides = {
      ...noopTmuxService,
      resolveSession: (target: WorkspaceSessionTarget) =>
        Effect.succeed(legacySession(target)),
      killSession: () => Effect.void,
    };
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  test("kills the verified tmux session ID for the current checkout", async () => {
    const killCalls: string[] = [];
    let isGitRepoArg: string | undefined;
    tmuxOverrides = {
      ...tmuxOverrides,
      killSession: (name: string) =>
        Effect.sync(() => {
          killCalls.push(name);
        }),
    };
    worktreeOverrides = {
      ...worktreeOverrides,
      isGitRepo: (cwd?: string) =>
        Effect.sync(() => {
          isGitRepoArg = cwd;
          return true;
        }),
    };
    cwdSpy.mockReturnValue("/tmp/myapp-feature-auth");

    await expect(
      runCommand(undefined, {
        tmux: tmuxOverrides,
        worktree: worktreeOverrides,
      }),
    ).resolves.toBeUndefined();
    expect(isGitRepoArg).toBe("/tmp/myapp-feature-auth");
    expect(killCalls).toEqual(["$1"]);
  });

  test("kills tmux session for worktree specified by --path", async () => {
    const killCalls: string[] = [];
    let isGitRepoArg: string | undefined;
    cwdSpy.mockReturnValue("/tmp/outside-git-repo");
    const pathOverrides: TmuxService = {
      ...noopTmuxService,
      resolveSession: (target: WorkspaceSessionTarget) =>
        Effect.succeed(legacySession(target)),
      killSession: (name: string) =>
        Effect.sync(() => {
          killCalls.push(name);
        }),
    };
    const worktreePathOverrides: WorktreeService = {
      ...shutdownWorktreeService,
      isGitRepo: (cwd?: string) =>
        Effect.sync(() => {
          isGitRepoArg = cwd;
          return true;
        }),
    };

    await runCommand(
      { path: "/tmp/myproject-feature-x" },
      { tmux: pathOverrides, worktree: worktreePathOverrides },
    );

    expect(isGitRepoArg).toBe("/tmp/myproject-feature-x");
    expect(killCalls).toEqual(["$1"]);
  });

  test("parses down --path through the root command", async () => {
    const killCalls: string[] = [];
    let isGitRepoArg: string | undefined;
    cwdSpy.mockReturnValue("/tmp/outside-git-repo");
    const tmuxOverridesViaRoot: TmuxService = {
      ...noopTmuxService,
      resolveSession: (target: WorkspaceSessionTarget) =>
        Effect.succeed(legacySession(target)),
      killSession: (name: string) =>
        Effect.sync(() => {
          killCalls.push(name);
        }),
    };
    const worktreeOverridesViaRoot: WorktreeService = {
      ...shutdownWorktreeService,
      isGitRepo: (cwd?: string) =>
        Effect.sync(() => {
          isGitRepoArg = cwd;
          return true;
        }),
    };

    await runRootCommand(["down", "--path", "/tmp/myproject-feature-x"], {
      tmux: tmuxOverridesViaRoot,
      worktree: worktreeOverridesViaRoot,
    });

    expect(isGitRepoArg).toBe("/tmp/myproject-feature-x");
    expect(killCalls).toEqual(["$1"]);
  });

  test("kills tmux session for worktree resolved by --branch", async () => {
    const killCalls: string[] = [];
    let isGitRepoArg: string | undefined;
    cwdSpy.mockReturnValue("/tmp/outside-git-repo");
    const tmuxOverridesByBranch: TmuxService = {
      ...noopTmuxService,
      resolveSession: (target: WorkspaceSessionTarget) =>
        Effect.succeed(legacySession(target)),
      killSession: (name: string) =>
        Effect.sync(() => {
          killCalls.push(name);
        }),
    };
    const worktreeOverridesByBranch: WorktreeService = {
      ...shutdownWorktreeService,
      isGitRepo: (cwd?: string) =>
        Effect.sync(() => {
          isGitRepoArg = cwd;
          return true;
        }),
      findWorktreeByBranch: (branch: string) =>
        Effect.succeed(
          branch === "feat-y"
            ? {
                path: "/tmp/myproject-feat-y",
                branch: "feat-y",
                commit: "abc123",
                isBare: false,
              }
            : null,
        ),
    };

    await runCommand(
      { branch: "feat-y" },
      { tmux: tmuxOverridesByBranch, worktree: worktreeOverridesByBranch },
    );

    expect(isGitRepoArg).toBe("/tmp/myproject-feat-y");
    expect(killCalls).toEqual(["$1"]);
  });

  test("propagates tmux kill failures", async () => {
    tmuxOverrides = {
      ...tmuxOverrides,
      killSession: () => Effect.fail(commandError("tmux_error", "tmux failed")),
    };

    await expect(
      runCommand(undefined, {
        tmux: tmuxOverrides,
        worktree: worktreeOverrides,
      }),
    ).rejects.toThrow("tmux failed");
  });

  test("prints absent tmux sessions as informational output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    tmuxOverrides = {
      ...tmuxOverrides,
      resolveSession: () => Effect.succeed(null),
    };
    cwdSpy.mockReturnValue("/tmp/myapp-feature-auth");

    try {
      await runCommand(undefined, {
        tmux: tmuxOverrides,
        worktree: worktreeOverrides,
      });

      const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(
        loggedLines.some((line) =>
          /No tmux session 'myapp-feature-auth-[0-9a-f]{10}' found/.test(line),
        ),
      ).toBe(true);
      expect(loggedLines.some((line) => line.includes("warn"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("json output emits the final result only", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runCommand(
        { path: "/tmp/myapp-feature-auth" },
        {
          json: true,
          workspace: {
            open: () => Effect.die("unused"),
            up: () => Effect.die("unused"),
            down: () =>
              Effect.succeed({
                operation: "down",
                worktreePath: "/tmp/myapp-feature-auth",
                sessionName: "myapp-feature-auth",
                existed: false,
                status: "absent",
                attempts: {
                  down: {
                    attempted: false as const,
                    reason: "down_not_configured",
                  },
                  kill: {
                    attempted: false,
                    reason: "session_absent",
                  },
                },
                warnings: [] as [],
              }),
            retryCloseRemoval: () => Effect.die("unused"),
            close: () => Effect.die("unused"),
          },
        },
      );

      expect(logSpy.mock.calls.length).toBe(1);
      const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
      expect(output).toEqual({
        ok: true,
        data: {
          operation: "down",
          worktreePath: "/tmp/myapp-feature-auth",
          sessionName: "myapp-feature-auth",
          existed: false,
          status: "absent",
          attempts: {
            down: { attempted: false as const, reason: "down_not_configured" },
            kill: {
              attempted: false,
              reason: "session_absent",
            },
          },
          warnings: [],
        },
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});

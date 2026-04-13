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
import { rootCommand } from "../src/cli/root-command";
import { type DownOptions, downCommand } from "../src/commands/down";
import { Command } from "../src/effect/cli";
import { runBunPromise } from "../src/effect/runtime";
import { commandError } from "../src/errors";
import {
  formatSessionName,
  liveTmuxService,
  type TmuxService,
} from "../src/services/tmux";
import {
  liveWorktreeService,
  type WorktreeService,
} from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

async function runCommand(
  options?: DownOptions,
  overrides: { tmux?: TmuxService; worktree?: WorktreeService } = {},
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
  let cwdSpy: MockInstance;
  let tmuxOverrides: TmuxService;
  let worktreeOverrides: WorktreeService;

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/outside-git-repo");
    worktreeOverrides = {
      ...liveWorktreeService,
      isGitRepo: () => Effect.succeed(true),
      findWorktreeByBranch: () => Effect.succeed(null),
    };
    tmuxOverrides = {
      ...liveTmuxService,
      sessionExists: () => Effect.succeed(true),
      killSession: () => Effect.succeed(undefined),
    };
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  test("kills tmux session derived from cwd basename", async () => {
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
    expect(killCalls).toEqual(["myapp-feature-auth"]);
  });

  test("kills tmux session for worktree specified by --path", async () => {
    const killCalls: string[] = [];
    let isGitRepoArg: string | undefined;
    cwdSpy.mockReturnValue("/tmp/outside-git-repo");
    const pathOverrides: TmuxService = {
      ...liveTmuxService,
      sessionExists: () => Effect.succeed(true),
      killSession: (name: string) =>
        Effect.sync(() => {
          killCalls.push(name);
        }),
    };
    const worktreePathOverrides: WorktreeService = {
      ...liveWorktreeService,
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
    expect(killCalls).toEqual(["myproject-feature-x"]);
  });

  test("parses down --path through the root command", async () => {
    const killCalls: string[] = [];
    let isGitRepoArg: string | undefined;
    cwdSpy.mockReturnValue("/tmp/outside-git-repo");
    const tmuxOverridesViaRoot: TmuxService = {
      ...liveTmuxService,
      sessionExists: () => Effect.succeed(true),
      killSession: (name: string) =>
        Effect.sync(() => {
          killCalls.push(name);
        }),
    };
    const worktreeOverridesViaRoot: WorktreeService = {
      ...liveWorktreeService,
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
    expect(killCalls).toEqual(["myproject-feature-x"]);
  });

  test("kills tmux session for worktree resolved by --branch", async () => {
    const killCalls: string[] = [];
    let isGitRepoArg: string | undefined;
    cwdSpy.mockReturnValue("/tmp/outside-git-repo");
    const tmuxOverridesByBranch: TmuxService = {
      ...liveTmuxService,
      sessionExists: () => Effect.succeed(true),
      killSession: (name: string) =>
        Effect.sync(() => {
          killCalls.push(name);
        }),
    };
    const worktreeOverridesByBranch: WorktreeService = {
      ...liveWorktreeService,
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
    expect(killCalls).toEqual(["myproject-feat-y"]);
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
});

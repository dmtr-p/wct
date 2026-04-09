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
import { downCommand } from "../src/commands/down";
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
  overrides: { tmux?: TmuxService; worktree?: WorktreeService } = {},
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
  let cwdSpy: MockInstance;
  let tmuxOverrides: TmuxService;
  let worktreeOverrides: WorktreeService;

  beforeEach(() => {
    cwdSpy = vi
      .spyOn(process, "cwd")
      .mockReturnValue("/tmp/myapp-feature-auth");
    worktreeOverrides = {
      ...liveWorktreeService,
      isGitRepo: () => Effect.succeed(true),
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

  test("propagates tmux kill failures", async () => {
    tmuxOverrides = {
      ...tmuxOverrides,
      killSession: () => Effect.fail(commandError("tmux_error", "tmux failed")),
    };

    await expect(
      runCommand({
        tmux: tmuxOverrides,
        worktree: worktreeOverrides,
      }),
    ).rejects.toThrow("tmux failed");
  });
});

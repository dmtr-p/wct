import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { commandDef, switchCommand } from "../src/commands/switch";
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
  branch: string,
  overrides: {
    tmux?: TmuxService;
    worktree?: WorktreeService;
  } = {},
) {
  await runBunPromise(withTestServices(switchCommand(branch), overrides));
}

describe("switchCommand", () => {
  test("is exported as a function", () => {
    expect(typeof switchCommand).toBe("function");
  });

  test("extracts basename from full worktree path for session name", async () => {
    const switchCalls: string[] = [];
    // Simulate being inside tmux so switchSession is called
    const origTmux = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";

    try {
      await expect(
        runCommand("feature-auth", {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            findWorktreeByBranch: () =>
              Effect.succeed({
                path: "/some/path/myapp-feature-auth",
                branch: "feature-auth",
                commit: "abc123",
                isBare: false,
              }),
          },
          tmux: {
            ...liveTmuxService,
            sessionExists: () => Effect.succeed(true),
            switchSession: (name) =>
              Effect.sync(() => {
                switchCalls.push(name);
              }),
          },
        }),
      ).resolves.toBeUndefined();
      expect(switchCalls).toEqual(["myapp-feature-auth"]);
    } finally {
      if (origTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = origTmux;
      }
    }
  });

  test("fails when attach-session fails outside tmux", async () => {
    const origTmux = process.env.TMUX;
    delete process.env.TMUX;

    try {
      await expect(
        runCommand("feature-auth", {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            findWorktreeByBranch: () =>
              Effect.succeed({
                path: "/some/path/myapp-feature-auth",
                branch: "feature-auth",
                commit: "abc123",
                isBare: false,
              }),
          },
          tmux: {
            ...liveTmuxService,
            sessionExists: () => Effect.succeed(true),
            attachSession: () =>
              Effect.fail(commandError("tmux_error", "attach failed")),
          },
        }),
      ).rejects.toThrow("attach failed");
    } finally {
      if (origTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = origTmux;
      }
    }
  });
});

describe("switch commandDef", () => {
  test("has correct name", () => {
    expect(commandDef.name).toBe("switch");
  });

  test("has sw alias", () => {
    expect(commandDef.aliases).toContain("sw");
  });

  test("has worktree completionType", () => {
    expect(commandDef.completionType).toBe("worktree");
  });

  test("requires a branch argument", () => {
    expect(commandDef.args).toBe("<branch>");
  });
});

describe("switch session name derivation", () => {
  test("derives session name from worktree directory basename", () => {
    const sessionName = formatSessionName("myapp-feature-auth");
    expect(sessionName).toBe("myapp-feature-auth");
  });

  test("sanitizes special characters in dirname", () => {
    const sessionName = formatSessionName("myapp.feature");
    expect(sessionName).toBe("myapp-feature");
  });

  test("preserves underscores and hyphens", () => {
    const sessionName = formatSessionName("my_app-feature");
    expect(sessionName).toBe("my_app-feature");
  });
});

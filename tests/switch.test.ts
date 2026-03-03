import { describe, expect, spyOn, test } from "bun:test";
import { commandDef, switchCommand } from "../src/commands/switch";
import * as tmux from "../src/services/tmux";
import { formatSessionName } from "../src/services/tmux";
import * as worktree from "../src/services/worktree";

describe("switchCommand", () => {
  test("is exported as a function", () => {
    expect(typeof switchCommand).toBe("function");
  });

  test("extracts basename from full worktree path for session name", async () => {
    const isGitRepoSpy = spyOn(worktree, "isGitRepo").mockResolvedValue(true);
    const findSpy = spyOn(worktree, "findWorktreeByBranch").mockResolvedValue({
      path: "/some/path/myapp-feature-auth",
      branch: "feature-auth",
      commit: "abc123",
      isBare: false,
    });
    const sessionExistsSpy = spyOn(tmux, "sessionExists").mockResolvedValue(
      true,
    );
    const switchSessionSpy = spyOn(tmux, "switchSession").mockResolvedValue({
      success: true,
      sessionName: "myapp-feature-auth",
    });
    // Simulate being inside tmux so switchSession is called
    const origTmux = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";

    try {
      const result = await switchCommand("feature-auth");
      expect(result.success).toBe(true);
      expect(switchSessionSpy).toHaveBeenCalledWith("myapp-feature-auth");
    } finally {
      if (origTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = origTmux;
      }
      isGitRepoSpy.mockRestore();
      findSpy.mockRestore();
      sessionExistsSpy.mockRestore();
      switchSessionSpy.mockRestore();
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

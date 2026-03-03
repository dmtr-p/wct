import { describe, expect, spyOn, test } from "bun:test";
import { closeCommand, commandDef } from "../src/commands/close";
import * as tmux from "../src/services/tmux";
import { formatSessionName } from "../src/services/tmux";
import * as worktree from "../src/services/worktree";
import * as prompt from "../src/utils/prompt";

describe("closeCommand", () => {
  test("is exported as a function", () => {
    expect(typeof closeCommand).toBe("function");
  });

  test("closes multiple branches in order", async () => {
    const isGitRepoSpy = spyOn(worktree, "isGitRepo").mockResolvedValue(true);
    const findSpy = spyOn(worktree, "findWorktreeByBranch").mockImplementation(
      async (branch) => ({
        path: `/tmp/myapp-${branch}`,
        branch,
        commit: "abc123",
        isBare: false,
      }),
    );
    const confirmSpy = spyOn(prompt, "confirm").mockResolvedValue(true);
    const currentSessionSpy = spyOn(
      tmux,
      "getCurrentSession",
    ).mockResolvedValue(null);
    const sessionExistsSpy = spyOn(tmux, "sessionExists").mockResolvedValue(
      true,
    );
    const killSessionSpy = spyOn(tmux, "killSession").mockImplementation(
      async (name) => ({
        success: true,
        sessionName: name,
      }),
    );
    const removeSpy = spyOn(worktree, "removeWorktree").mockImplementation(
      async (path) => ({
        success: true,
        path,
      }),
    );

    try {
      const result = await closeCommand({
        branches: ["feature-a", "feature-b"],
      });
      expect(result.success).toBe(true);
      expect(findSpy).toHaveBeenNthCalledWith(1, "feature-a");
      expect(findSpy).toHaveBeenNthCalledWith(2, "feature-b");
      expect(confirmSpy).toHaveBeenCalledTimes(2);
      expect(killSessionSpy).toHaveBeenNthCalledWith(
        1,
        formatSessionName("myapp-feature-a"),
      );
      expect(killSessionSpy).toHaveBeenNthCalledWith(
        2,
        formatSessionName("myapp-feature-b"),
      );
      expect(removeSpy).toHaveBeenNthCalledWith(
        1,
        "/tmp/myapp-feature-a",
        false,
      );
      expect(removeSpy).toHaveBeenNthCalledWith(
        2,
        "/tmp/myapp-feature-b",
        false,
      );
    } finally {
      isGitRepoSpy.mockRestore();
      findSpy.mockRestore();
      confirmSpy.mockRestore();
      currentSessionSpy.mockRestore();
      sessionExistsSpy.mockRestore();
      killSessionSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  test("stops on first missing branch in multi-close", async () => {
    const isGitRepoSpy = spyOn(worktree, "isGitRepo").mockResolvedValue(true);
    const findSpy = spyOn(worktree, "findWorktreeByBranch").mockImplementation(
      async (branch) => {
        if (branch === "missing") {
          return null;
        }
        return {
          path: `/tmp/myapp-${branch}`,
          branch,
          commit: "abc123",
          isBare: false,
        };
      },
    );
    const confirmSpy = spyOn(prompt, "confirm").mockResolvedValue(true);
    const currentSessionSpy = spyOn(
      tmux,
      "getCurrentSession",
    ).mockResolvedValue(null);
    const sessionExistsSpy = spyOn(tmux, "sessionExists").mockResolvedValue(
      true,
    );
    const killSessionSpy = spyOn(tmux, "killSession").mockImplementation(
      async (name) => ({
        success: true,
        sessionName: name,
      }),
    );
    const removeSpy = spyOn(worktree, "removeWorktree").mockImplementation(
      async (path) => ({
        success: true,
        path,
      }),
    );

    try {
      const result = await closeCommand({
        branches: ["feature-a", "missing", "feature-c"],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("worktree_not_found");
        expect(result.error.message).toContain("missing");
      }
      expect(findSpy).toHaveBeenCalledTimes(2);
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(killSessionSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledTimes(1);
    } finally {
      isGitRepoSpy.mockRestore();
      findSpy.mockRestore();
      confirmSpy.mockRestore();
      currentSessionSpy.mockRestore();
      sessionExistsSpy.mockRestore();
      killSessionSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  test("stops on first remove failure", async () => {
    const isGitRepoSpy = spyOn(worktree, "isGitRepo").mockResolvedValue(true);
    const findSpy = spyOn(worktree, "findWorktreeByBranch").mockImplementation(
      async (branch) => ({
        path: `/tmp/myapp-${branch}`,
        branch,
        commit: "abc123",
        isBare: false,
      }),
    );
    const confirmSpy = spyOn(prompt, "confirm").mockResolvedValue(true);
    const currentSessionSpy = spyOn(
      tmux,
      "getCurrentSession",
    ).mockResolvedValue(null);
    const sessionExistsSpy = spyOn(tmux, "sessionExists").mockResolvedValue(
      true,
    );
    const killSessionSpy = spyOn(tmux, "killSession").mockImplementation(
      async (name) => ({
        success: true,
        sessionName: name,
      }),
    );
    const removeSpy = spyOn(worktree, "removeWorktree").mockImplementation(
      async (path) => {
        if (path.endsWith("feature-b")) {
          return {
            success: false,
            path,
            error: "fatal: contains modified or untracked files",
          };
        }
        return {
          success: true,
          path,
        };
      },
    );

    try {
      const result = await closeCommand({
        branches: ["feature-a", "feature-b", "feature-c"],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("worktree_remove_failed");
        expect(result.error.message).toContain("Use --force");
      }
      expect(findSpy).toHaveBeenCalledTimes(2);
      expect(confirmSpy).toHaveBeenCalledTimes(2);
      expect(killSessionSpy).toHaveBeenCalledTimes(2);
      expect(removeSpy).toHaveBeenCalledTimes(2);
    } finally {
      isGitRepoSpy.mockRestore();
      findSpy.mockRestore();
      confirmSpy.mockRestore();
      currentSessionSpy.mockRestore();
      sessionExistsSpy.mockRestore();
      killSessionSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  test("skips confirmations for all branches with --yes", async () => {
    const isGitRepoSpy = spyOn(worktree, "isGitRepo").mockResolvedValue(true);
    const findSpy = spyOn(worktree, "findWorktreeByBranch").mockImplementation(
      async (branch) => ({
        path: `/tmp/myapp-${branch}`,
        branch,
        commit: "abc123",
        isBare: false,
      }),
    );
    const confirmSpy = spyOn(prompt, "confirm").mockResolvedValue(true);
    const currentSessionSpy = spyOn(
      tmux,
      "getCurrentSession",
    ).mockResolvedValue("myapp-feature-a");
    const sessionExistsSpy = spyOn(tmux, "sessionExists").mockResolvedValue(
      true,
    );
    const killSessionSpy = spyOn(tmux, "killSession").mockImplementation(
      async (name) => ({
        success: true,
        sessionName: name,
      }),
    );
    const removeSpy = spyOn(worktree, "removeWorktree").mockImplementation(
      async (path) => ({
        success: true,
        path,
      }),
    );

    try {
      const result = await closeCommand({
        branches: ["feature-a", "feature-b"],
        yes: true,
      });
      expect(result.success).toBe(true);
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(killSessionSpy).toHaveBeenCalledTimes(2);
      expect(removeSpy).toHaveBeenCalledTimes(2);
    } finally {
      isGitRepoSpy.mockRestore();
      findSpy.mockRestore();
      confirmSpy.mockRestore();
      currentSessionSpy.mockRestore();
      sessionExistsSpy.mockRestore();
      killSessionSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  test("defers current tmux session branch until last in multi-close", async () => {
    const isGitRepoSpy = spyOn(worktree, "isGitRepo").mockResolvedValue(true);
    const findSpy = spyOn(worktree, "findWorktreeByBranch").mockImplementation(
      async (branch) => ({
        path: `/tmp/myapp-${branch}`,
        branch,
        commit: "abc123",
        isBare: false,
      }),
    );
    const prompts: string[] = [];
    const confirmSpy = spyOn(prompt, "confirm").mockImplementation(
      async (message) => {
        prompts.push(message);
        return true;
      },
    );
    const currentSessionSpy = spyOn(
      tmux,
      "getCurrentSession",
    ).mockResolvedValue("myapp-feature-a");
    const sessionExistsSpy = spyOn(tmux, "sessionExists").mockResolvedValue(
      true,
    );
    const killSessionSpy = spyOn(tmux, "killSession").mockImplementation(
      async (name) => ({
        success: true,
        sessionName: name,
      }),
    );
    const removeSpy = spyOn(worktree, "removeWorktree").mockImplementation(
      async (path) => ({
        success: true,
        path,
      }),
    );

    try {
      const result = await closeCommand({
        branches: ["feature-a", "feature-b"],
      });
      expect(result.success).toBe(true);
      expect(killSessionSpy).toHaveBeenNthCalledWith(1, "myapp-feature-b");
      expect(killSessionSpy).toHaveBeenNthCalledWith(2, "myapp-feature-a");
      expect(removeSpy).toHaveBeenNthCalledWith(
        1,
        "/tmp/myapp-feature-b",
        false,
      );
      expect(removeSpy).toHaveBeenNthCalledWith(
        2,
        "/tmp/myapp-feature-a",
        false,
      );
      expect(prompts[0]).toContain("feature-b");
      expect(prompts[1]).toContain("feature-a");
      expect(prompts[2]).toContain("inside this tmux session");
      expect(findSpy).toHaveBeenCalledTimes(3);
    } finally {
      isGitRepoSpy.mockRestore();
      findSpy.mockRestore();
      confirmSpy.mockRestore();
      currentSessionSpy.mockRestore();
      sessionExistsSpy.mockRestore();
      killSessionSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});

describe("close commandDef", () => {
  test("uses variadic branch args", () => {
    expect(commandDef.args).toBe("<branch...>");
  });
});

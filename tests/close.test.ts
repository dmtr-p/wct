import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeCommand, commandDef } from "../src/commands/close";
import * as queue from "../src/services/queue";
import * as tmux from "../src/services/tmux";
import { formatSessionName } from "../src/services/tmux";
import * as worktree from "../src/services/worktree";
import * as prompt from "../src/utils/prompt";

interface CloseCommandSpies {
  isGitRepoSpy: ReturnType<typeof spyOn<typeof worktree, "isGitRepo">>;
  findSpy: ReturnType<typeof spyOn<typeof worktree, "findWorktreeByBranch">>;
  confirmSpy: ReturnType<typeof spyOn<typeof prompt, "confirm">>;
  currentSessionSpy: ReturnType<typeof spyOn<typeof tmux, "getCurrentSession">>;
  sessionExistsSpy: ReturnType<typeof spyOn<typeof tmux, "sessionExists">>;
  killSessionSpy: ReturnType<typeof spyOn<typeof tmux, "killSession">>;
  removeItemsBySessionSpy: ReturnType<
    typeof spyOn<typeof queue, "removeItemsBySession">
  >;
  removeSpy: ReturnType<typeof spyOn<typeof worktree, "removeWorktree">>;
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
  const isGitRepoSpy = spyOn(worktree, "isGitRepo").mockResolvedValue(true);
  const findSpy = spyOn(worktree, "findWorktreeByBranch").mockImplementation(
    async (branch) => makeWorktree(branch),
  );
  const confirmSpy = spyOn(prompt, "confirm").mockResolvedValue(true);
  const currentSessionSpy = spyOn(tmux, "getCurrentSession").mockResolvedValue(
    null,
  );
  const sessionExistsSpy = spyOn(tmux, "sessionExists").mockResolvedValue(true);
  const killSessionSpy = spyOn(tmux, "killSession").mockImplementation(
    async (name) => ({
      success: true,
      sessionName: name,
    }),
  );
  const removeItemsBySessionSpy = spyOn(
    queue,
    "removeItemsBySession",
  ).mockReturnValue(0);
  const removeSpy = spyOn(worktree, "removeWorktree").mockImplementation(
    async (path) => ({
      success: true,
      path,
    }),
  );

  return {
    isGitRepoSpy,
    findSpy,
    confirmSpy,
    currentSessionSpy,
    sessionExistsSpy,
    killSessionSpy,
    removeItemsBySessionSpy,
    removeSpy,
    restore: () => {
      isGitRepoSpy.mockRestore();
      findSpy.mockRestore();
      confirmSpy.mockRestore();
      currentSessionSpy.mockRestore();
      sessionExistsSpy.mockRestore();
      killSessionSpy.mockRestore();
      removeItemsBySessionSpy.mockRestore();
      removeSpy.mockRestore();
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
    const result = await closeCommand({
      branches: ["feature-a", "feature-b"],
    });

    expect(result.success).toBe(true);
    expect(mocks.findSpy).toHaveBeenNthCalledWith(1, "feature-a");
    expect(mocks.findSpy).toHaveBeenNthCalledWith(2, "feature-b");
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(2);
    expect(mocks.killSessionSpy).toHaveBeenNthCalledWith(
      1,
      formatSessionName("myapp-feature-a"),
    );
    expect(mocks.killSessionSpy).toHaveBeenNthCalledWith(
      2,
      formatSessionName("myapp-feature-b"),
    );
    expect(mocks.removeSpy).toHaveBeenNthCalledWith(
      1,
      "/tmp/myapp-feature-a",
      false,
    );
    expect(mocks.removeSpy).toHaveBeenNthCalledWith(
      2,
      "/tmp/myapp-feature-b",
      false,
    );
  });

  test("stops on first missing branch in multi-close", async () => {
    mocks.findSpy.mockImplementation(async (branch) => {
      if (branch === "missing") {
        return null;
      }
      return makeWorktree(branch);
    });

    const result = await closeCommand({
      branches: ["feature-a", "missing", "feature-c"],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("worktree_not_found");
      expect(result.error.message).toContain("missing");
    }
    expect(mocks.findSpy).toHaveBeenCalledTimes(2);
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(1);
    expect(mocks.killSessionSpy).toHaveBeenCalledTimes(1);
    expect(mocks.removeSpy).toHaveBeenCalledTimes(1);
  });

  test("stops on first remove failure", async () => {
    mocks.removeSpy.mockImplementation(async (path) => {
      if (path.endsWith("feature-b")) {
        return {
          success: false,
          path,
          code: "worktree_has_uncommitted_changes",
          error: "fatal: contains modified or untracked files",
        };
      }
      return {
        success: true,
        path,
      };
    });

    const result = await closeCommand({
      branches: ["feature-a", "feature-b", "feature-c"],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("worktree_remove_failed");
      expect(result.error.message).toContain("Use --force");
    }
    expect(mocks.findSpy).toHaveBeenCalledTimes(2);
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(2);
    expect(mocks.killSessionSpy).toHaveBeenCalledTimes(2);
    expect(mocks.removeSpy).toHaveBeenCalledTimes(2);
  });

  test("skips confirmations for all branches with --yes", async () => {
    mocks.currentSessionSpy.mockResolvedValue("myapp-feature-a");

    const result = await closeCommand({
      branches: ["feature-a", "feature-b"],
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(mocks.confirmSpy).not.toHaveBeenCalled();
    expect(mocks.killSessionSpy).toHaveBeenCalledTimes(2);
    expect(mocks.removeSpy).toHaveBeenCalledTimes(2);
  });

  test("defers current tmux session branch until last in multi-close", async () => {
    const prompts: string[] = [];
    mocks.confirmSpy.mockImplementation(async (message) => {
      prompts.push(message);
      return true;
    });
    mocks.currentSessionSpy.mockResolvedValue("myapp-feature-a");

    const result = await closeCommand({
      branches: ["feature-a", "feature-b"],
    });

    expect(result.success).toBe(true);
    expect(mocks.killSessionSpy).toHaveBeenNthCalledWith(1, "myapp-feature-b");
    expect(mocks.killSessionSpy).toHaveBeenNthCalledWith(2, "myapp-feature-a");
    expect(mocks.removeSpy).toHaveBeenNthCalledWith(
      1,
      "/tmp/myapp-feature-b",
      false,
    );
    expect(mocks.removeSpy).toHaveBeenNthCalledWith(
      2,
      "/tmp/myapp-feature-a",
      false,
    );
    expect(prompts[0]).toContain("feature-b");
    expect(prompts[1]).toContain("feature-a");
    expect(prompts[2]).toContain("inside this tmux session");
    expect(mocks.confirmSpy).toHaveBeenCalledTimes(3);
  });

  test("removes queue items only after a successful session kill", async () => {
    const result = await closeCommand({
      branches: ["feature-a"],
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(mocks.killSessionSpy).toHaveBeenCalledTimes(1);
    expect(mocks.removeItemsBySessionSpy).toHaveBeenCalledTimes(1);
    expect(
      mocks.removeItemsBySessionSpy.mock.invocationCallOrder[0],
    ).toBeGreaterThan(mocks.killSessionSpy.mock.invocationCallOrder[0] ?? 0);
  });

  test("does not remove queue items when killSession fails", async () => {
    mocks.killSessionSpy.mockResolvedValue({
      success: false,
      sessionName: "myapp-feature-a",
      error: "tmux failed",
    });

    const result = await closeCommand({
      branches: ["feature-a"],
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(mocks.removeItemsBySessionSpy).not.toHaveBeenCalled();
  });
});

describe("close commandDef", () => {
  test("uses variadic branch args", () => {
    expect(commandDef.args).toBe("<branch...>");
  });
});

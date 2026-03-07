import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { downCommand } from "../src/commands/down";
import * as queue from "../src/services/queue";
import * as tmux from "../src/services/tmux";
import { formatSessionName } from "../src/services/tmux";
import * as worktree from "../src/services/worktree";

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
  let isGitRepoSpy: ReturnType<typeof spyOn<typeof worktree, "isGitRepo">>;
  let sessionExistsSpy: ReturnType<typeof spyOn<typeof tmux, "sessionExists">>;
  let killSessionSpy: ReturnType<typeof spyOn<typeof tmux, "killSession">>;
  let removeItemsBySessionSpy: ReturnType<
    typeof spyOn<typeof queue, "removeItemsBySession">
  >;

  beforeEach(() => {
    cwdSpy = spyOn(process, "cwd").mockReturnValue("/tmp/myapp-feature-auth");
    isGitRepoSpy = spyOn(worktree, "isGitRepo").mockResolvedValue(true);
    sessionExistsSpy = spyOn(tmux, "sessionExists").mockResolvedValue(true);
    killSessionSpy = spyOn(tmux, "killSession").mockResolvedValue({
      success: true,
      sessionName: "myapp-feature-auth",
    });
    removeItemsBySessionSpy = spyOn(
      queue,
      "removeItemsBySession",
    ).mockReturnValue(0);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    isGitRepoSpy.mockRestore();
    sessionExistsSpy.mockRestore();
    killSessionSpy.mockRestore();
    removeItemsBySessionSpy.mockRestore();
  });

  test("removes queue items only after a successful kill", async () => {
    const result = await downCommand();

    expect(result.success).toBe(true);
    expect(removeItemsBySessionSpy).toHaveBeenCalledTimes(1);
    expect(removeItemsBySessionSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      killSessionSpy.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("does not remove queue items when killSession fails", async () => {
    killSessionSpy.mockResolvedValue({
      success: false,
      sessionName: "myapp-feature-auth",
      error: "tmux failed",
    });

    const result = await downCommand();

    expect(result.success).toBe(false);
    expect(removeItemsBySessionSpy).not.toHaveBeenCalled();
  });
});

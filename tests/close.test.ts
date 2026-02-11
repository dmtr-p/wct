import { describe, expect, test } from "bun:test";
import { formatSessionName } from "../src/services/tmux";
import { confirm } from "../src/utils/prompt";

describe("close command", () => {
  describe("confirm prompt", () => {
    test("confirm function is defined", () => {
      expect(typeof confirm).toBe("function");
    });
  });

  describe("session name generation for close", () => {
    test("generates session name from worktree dirname", () => {
      const sessionName = formatSessionName("myapp-feature-auth");
      expect(sessionName).toBe("myapp-feature-auth");
    });

    test("sanitizes special characters in dirname", () => {
      const sessionName = formatSessionName("myapp-feature.auth");
      expect(sessionName).toBe("myapp-feature-auth");
    });
  });

  describe("dirty worktree error detection", () => {
    // Tests the error pattern matching used in closeCommand to detect
    // when a worktree has uncommitted changes
    const isDirtyWorktreeError = (error: string | undefined): boolean => {
      return error?.includes("contains modified or untracked files") ?? false;
    };

    test("detects dirty worktree error from git", () => {
      const error =
        "fatal: cannot remove '/path/to/worktree': contains modified or untracked files, use --force to delete";
      expect(isDirtyWorktreeError(error)).toBe(true);
    });

    test("does not flag other git errors as dirty worktree", () => {
      const error =
        "fatal: '/path/to/worktree' is not a valid worktree directory";
      expect(isDirtyWorktreeError(error)).toBe(false);
    });

    test("handles undefined error", () => {
      expect(isDirtyWorktreeError(undefined)).toBe(false);
    });
  });
});

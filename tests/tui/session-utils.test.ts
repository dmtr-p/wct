import { describe, expect, test } from "vitest";
import type { WorkspaceUpResult } from "../../src/services/workspace-service";
import { resolveStartActionMessage } from "../../src/tui/session-utils";

function workspaceUpResult(
  overrides: Partial<WorkspaceUpResult> = {},
): WorkspaceUpResult {
  return {
    operation: "up",
    worktreePath: "/repo/feat",
    mainRepoPath: "/repo",
    branch: "feat",
    sessionName: "feat",
    projectName: "proj",
    env: {
      WCT_WORKTREE_DIR: "/repo/feat",
      WCT_WORK_DIR: "/repo/feat",
      WCT_MAIN_DIR: "/repo",
      WCT_BRANCH: "feat",
      WCT_PROJECT: "proj",
    },
    warnings: [],
    attempts: {
      tmux: { attempted: false, reason: "tmux_not_configured" },
    },
    ...overrides,
  };
}

describe("resolveStartActionMessage", () => {
  test("returns a tmux failure from WorkspaceService up results", () => {
    const result = workspaceUpResult({
      attempts: {
        tmux: {
          attempted: true,
          ok: false,
          error: {
            code: "tmux_error",
            message: "tmux failed",
          },
        },
      },
    });

    expect(resolveStartActionMessage(result)).toBe("tmux failed");
  });
});

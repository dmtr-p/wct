import { describe, expect, test } from "vitest";
import type { WorkspaceUpResult } from "../../src/services/workspace-service";
import {
  resolveStartActionMessage,
  workspaceUpToStartResult,
} from "../../src/tui/session-utils";

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
      WCT_MAIN_DIR: "/repo",
      WCT_BRANCH: "feat",
      WCT_PROJECT: "proj",
    },
    warnings: [],
    attempts: {
      tmux: { attempted: false, reason: "tmux_not_configured" },
      ide: { attempted: false, reason: "ide_not_configured" },
    },
    ...overrides,
  };
}

describe("workspaceUpToStartResult", () => {
  test("converts tmux failure into the existing start-action message path", () => {
    const result = workspaceUpToStartResult(
      workspaceUpResult({
        attempts: {
          tmux: {
            attempted: true,
            ok: false,
            error: {
              code: "tmux_error",
              message: "tmux failed",
            },
          },
          ide: { attempted: false, reason: "ide_not_configured" },
        },
      }),
    );

    expect(resolveStartActionMessage(result)).toBe("tmux failed");
    expect(result.tmux).toMatchObject({
      attempted: true,
      ok: false,
      error: {
        code: "unexpected_error",
        message: "tmux failed",
        cause: "tmux_error",
      },
    });
  });

  test("converts IDE failure into the existing start-action message path", () => {
    const result = workspaceUpToStartResult(
      workspaceUpResult({
        attempts: {
          tmux: { attempted: false, reason: "tmux_not_configured" },
          ide: {
            attempted: true,
            ok: false,
            error: {
              code: "ide_error",
              message: "IDE failed",
            },
          },
        },
      }),
    );

    expect(resolveStartActionMessage(result)).toBe("IDE failed");
    expect(result.ide).toMatchObject({
      attempted: true,
      ok: false,
      error: {
        code: "unexpected_error",
        message: "IDE failed",
        cause: "ide_error",
      },
    });
  });
});

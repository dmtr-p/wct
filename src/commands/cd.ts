import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { spawnInteractive } from "../services/process";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "cd",
  description: "Open a shell in a worktree directory",
  args: "<branch>",
  completionType: "worktree",
};

export function cdCommand(
  branch: string,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const repo = yield* WorktreeService.use((service) => service.isGitRepo());
    if (!repo) {
      return yield* Effect.fail(
        commandError("not_git_repo", "Not a git repository"),
      );
    }

    const worktree = yield* WorktreeService.use((service) =>
      service.findWorktreeByBranch(branch),
    );
    if (!worktree) {
      return yield* Effect.fail(
        commandError(
          "worktree_not_found",
          `No worktree found for branch '${branch}'. Try: wct open ${branch}`,
        ),
      );
    }

    const shell = process.env.SHELL ?? "/bin/sh";

    yield* logger.info(`Entering ${worktree.path} (exit to return)`);

    yield* Effect.mapError(
      spawnInteractive(shell, [], {
        cwd: worktree.path,
      }),
      (error) =>
        commandError(
          "worktree_error",
          `Failed to enter worktree '${worktree.path}'`,
          error,
        ),
    );
  });
}

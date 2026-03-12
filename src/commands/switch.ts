import { basename } from "node:path";
import { Effect } from "effect";
import { commandError } from "../errors";
import { formatSessionName, TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "switch",
  aliases: ["sw"],
  description: "Switch to another worktree's tmux session",
  args: "<branch>",
  completionType: "worktree",
};

export function switchCommand(branch: string) {
  return Effect.gen(function* () {
    const isRepo = yield* WorktreeService.use((service) => service.isGitRepo());
    if (!isRepo) {
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

    const sessionName = formatSessionName(basename(worktree.path));
    const sessionPresent = yield* TmuxService.use((service) =>
      service.sessionExists(sessionName),
    );
    if (!sessionPresent) {
      return yield* Effect.fail(
        commandError(
          "tmux_error",
          `No tmux session '${sessionName}' for branch '${branch}'. Try: wct up (from the worktree directory)`,
        ),
      );
    }

    if (process.env.TMUX) {
      yield* TmuxService.use((service) => service.switchSession(sessionName));
      yield* logger.success(`Switched to session '${sessionName}'`);
      return;
    }

    yield* logger.info(`Attaching to session '${sessionName}'...`);

    yield* TmuxService.use((service) => service.attachSession(sessionName));
  });
}

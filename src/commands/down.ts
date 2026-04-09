import { basename } from "node:path";
import { Effect } from "effect";
import { commandError } from "../errors";
import { formatSessionName, TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "down",
  description: "Kill tmux session for current directory",
};

export function downCommand() {
  return Effect.gen(function* () {
    const isRepo = yield* WorktreeService.use((service) => service.isGitRepo());
    if (!isRepo) {
      return yield* Effect.fail(
        commandError("not_git_repo", "Not a git repository"),
      );
    }

    const cwd = process.cwd();
    const sessionName = formatSessionName(basename(cwd));

    const exists = yield* TmuxService.use((service) =>
      service.sessionExists(sessionName),
    );
    if (!exists) {
      yield* logger.warn(`No tmux session '${sessionName}' found`);
      return;
    }

    yield* logger.info(`Killing tmux session '${sessionName}'...`);

    yield* TmuxService.use((service) => service.killSession(sessionName));

    yield* logger.success(`Killed tmux session '${sessionName}'`);
  });
}

import { basename } from "node:path";
import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { formatSessionName, TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";
import { resolveWorktreePath } from "./resolve-worktree-path";

export const commandDef: CommandDef = {
  name: "down",
  description: "Kill tmux session for a worktree",
  options: [
    {
      name: "path",
      type: "string",
      placeholder: "path",
      description: "Path to worktree directory",
    },
    {
      name: "branch",
      short: "b",
      type: "string",
      placeholder: "name",
      description: "Branch name to resolve worktree from",
      completionValues: "__wct_branches",
    },
  ],
};

export interface DownOptions {
  path?: string;
  branch?: string;
}

export function downCommand(
  options?: DownOptions,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const cwd = yield* resolveWorktreePath({
      path: options?.path,
      branch: options?.branch,
    });

    const isRepo = yield* WorktreeService.use((service) =>
      service.isGitRepo(cwd),
    );
    if (!isRepo) {
      return yield* Effect.fail(
        commandError("not_git_repo", "Not a git repository"),
      );
    }

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

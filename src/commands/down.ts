import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import type { WctError } from "../errors";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";
import { stopWorktreeSession } from "./worktree-session";

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
      completionValues: "__wct_worktree_branches",
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
    const result = yield* stopWorktreeSession({
      path: options?.path,
      branch: options?.branch,
    });

    if (!result.existed) {
      yield* logger.warn(`No tmux session '${result.sessionName}' found`);
      return;
    }

    yield* logger.success(`Killed tmux session '${result.sessionName}'`);
  });
}

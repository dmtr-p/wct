import { Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";
import type { WctServices } from "../effect/services";
import type { WctError } from "../errors";
import { WorkspaceService } from "../services/workspace-service";
import { jsonSuccess } from "../utils/json-output";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

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
): Effect.Effect<
  void,
  WctError,
  WctServices | "effect/unstable/cli/GlobalFlag/json"
> {
  return Effect.gen(function* () {
    const result = yield* WorkspaceService.use((service) =>
      service.down({
        path: options?.path,
        branch: options?.branch,
      }),
    );
    const json = yield* JsonFlag;

    if (json) {
      yield* jsonSuccess(result);
      return;
    }

    if (!result.existed) {
      yield* logger.info(`No tmux session '${result.sessionName}' found`);
      return;
    }

    yield* logger.success(`Killed tmux session '${result.sessionName}'`);
  });
}

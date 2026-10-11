import { Effect, Stdio } from "effect";
import { JsonFlag } from "../cli/json-flag";
import type { WctServices } from "../effect/services";
import type { WctError } from "../errors";
import { WorkspaceService } from "../services/workspace-service";
import { jsonSuccess } from "../utils/json-output";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";
import { createDownHumanReporter } from "./down-reporter";

export const commandDef: CommandDef = {
  name: "down",
  description: "Stop tmux session and run down scripts",
  options: [
    {
      name: "profile",
      short: "P",
      type: "string",
      placeholder: "name",
      description: "Use a named config profile",
      completionValues: "__wct_profiles",
    },
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
  profile?: string;
  path?: string;
  branch?: string;
}

export function downCommand(
  options?: DownOptions,
): Effect.Effect<void, WctError, WctServices | "effect/cli/GlobalFlag/json"> {
  return Effect.gen(function* () {
    const json = yield* JsonFlag;
    const reporter = json
      ? undefined
      : createDownHumanReporter(yield* Stdio.Stdio);
    const result = yield* WorkspaceService.use((service) =>
      service.down({
        path: options?.path,
        branch: options?.branch,
        ...(options?.profile !== undefined ? { profile: options.profile } : {}),
        ...(reporter ? { reporter } : {}),
      }),
    );
    if (json) {
      yield* jsonSuccess(result);
      return;
    }

    if (!result.existed) {
      yield* logger.info(`No tmux session '${result.sessionName}' found`);
      return;
    }

    yield* logger.success(`Stopped tmux session '${result.sessionName}'`);
  });
}

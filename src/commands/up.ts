import { Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";
import type { WctServices } from "../effect/services";
import type { WctError } from "../errors";
import { WorkspaceService } from "../services/workspace-service";
import { jsonSuccess } from "../utils/json-output";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";
import { maybeAttachSession } from "./session";

export const commandDef: CommandDef = {
  name: "up",
  description: "Start configured environment for a worktree",
  options: [
    {
      name: "ide",
      type: "boolean",
      description: "Force opening IDE",
    },
    {
      name: "no-ide",
      type: "boolean",
      description: "Skip opening IDE",
    },
    {
      name: "no-attach",
      type: "boolean",
      description: "Do not attach to tmux outside tmux",
    },
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

export interface UpOptions {
  ide?: boolean;
  noIde?: boolean;
  noAttach?: boolean;
  profile?: string;
  path?: string;
  branch?: string;
}

export function upCommand(
  options?: UpOptions,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const { ide, noIde, noAttach, profile, path, branch } = options ?? {};
    const result = yield* WorkspaceService.use((service) =>
      service.up({ ide, noIde, profile, path, branch }),
    );
    const json = yield* JsonFlag;

    if (json) {
      yield* jsonSuccess(result);
      return;
    }

    if (result.profileName) {
      yield* logger.info(`Using profile '${result.profileName}'`);
    }

    if (result.attempts.tmux.attempted) {
      if (result.attempts.tmux.ok) {
        yield* result.attempts.tmux.value._tag === "AlreadyExists"
          ? logger.info(`Tmux session '${result.sessionName}' already exists`)
          : logger.success(`Created tmux session '${result.sessionName}'`);
      } else {
        yield* logger.warn(
          `Failed to create tmux session: ${result.attempts.tmux.error.message}`,
        );
      }
    }

    if (result.attempts.ide.attempted) {
      if (result.attempts.ide.ok) {
        yield* logger.success("IDE opened");
      } else {
        yield* logger.warn(
          `Failed to open IDE: ${result.attempts.ide.error.message}`,
        );
      }
    }

    if (result.attempts.tmux.attempted && result.attempts.tmux.ok) {
      yield* maybeAttachSession(result.sessionName, noAttach);
    }

    yield* logger.success(`Environment ready for '${result.branch}'`);
  });
}

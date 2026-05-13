import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import type { WctError } from "../errors";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";
import { maybeAttachSession } from "./session";
import { startWorktreeSession } from "./worktree-session";

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
    const result = yield* startWorktreeSession({
      ide,
      noIde,
      profile,
      path,
      branch,
    });

    if (result.profileName) {
      yield* logger.info(`Using profile '${result.profileName}'`);
    }

    if (result.tmux.attempted) {
      if (result.tmux.ok) {
        yield* result.tmux.value._tag === "AlreadyExists"
          ? logger.info(`Tmux session '${result.sessionName}' already exists`)
          : logger.success(`Created tmux session '${result.sessionName}'`);
      } else {
        yield* logger.warn(
          `Failed to create tmux session: ${result.tmux.error.message}`,
        );
      }
    }

    if (result.ide.attempted) {
      if (result.ide.ok) {
        yield* logger.success("IDE opened");
      } else {
        yield* logger.warn(`Failed to open IDE: ${result.ide.error.message}`);
      }
    }

    if (result.tmux.attempted && result.tmux.ok) {
      yield* maybeAttachSession(result.sessionName, noAttach);
    }

    yield* logger.success(`Environment ready for '${result.branch}'`);
  });
}

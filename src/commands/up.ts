import { basename } from "node:path";
import { Effect } from "effect";
import { loadConfig, resolveProfile } from "../config/loader";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { formatSessionName } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import type { WctEnv } from "../types/env";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";
import { launchSessionAndIde } from "./session";

export const commandDef: CommandDef = {
  name: "up",
  description: "Start tmux session and open IDE in current directory",
  options: [
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
  ],
};

export interface UpOptions {
  noIde?: boolean;
  noAttach?: boolean;
  profile?: string;
}

export function upCommand(
  options?: UpOptions,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const { noIde, noAttach, profile } = options ?? {};
    const repo = yield* WorktreeService.use((service) => service.isGitRepo());
    if (!repo) {
      return yield* Effect.fail(
        commandError("not_git_repo", "Not a git repository"),
      );
    }

    const cwd = process.cwd();

    const [mainRepoPath, branch] = yield* Effect.all([
      WorktreeService.use((service) => service.getMainRepoPath()),
      WorktreeService.use((service) => service.getCurrentBranch()),
    ]);

    if (!mainRepoPath) {
      return yield* Effect.fail(
        commandError("worktree_error", "Could not determine repository root"),
      );
    }
    if (!branch) {
      return yield* Effect.fail(
        commandError(
          "detached_head",
          "Could not determine current branch (detached HEAD is not supported)",
        ),
      );
    }

    const { config, errors } = yield* Effect.tryPromise({
      try: () => loadConfig(mainRepoPath),
      catch: (error) =>
        commandError("config_error", "Failed to load configuration", error),
    });
    if (!config) {
      return yield* Effect.fail(
        commandError("config_error", errors.join("\n")),
      );
    }

    const { config: resolved, profileName } = yield* Effect.try({
      try: () => resolveProfile(config, branch, profile),
      catch: (error) =>
        commandError(
          "config_error",
          error instanceof Error ? error.message : String(error),
        ),
    });
    if (profileName) {
      yield* logger.info(`Using profile '${profileName}'`);
    }

    const sessionName = formatSessionName(basename(cwd));

    const env: WctEnv = {
      WCT_WORKTREE_DIR: cwd,
      WCT_MAIN_DIR: mainRepoPath,
      WCT_BRANCH: branch,
      WCT_PROJECT: config.project_name,
    };

    yield* launchSessionAndIde({
      sessionName,
      workingDir: cwd,
      tmuxConfig: resolved.tmux,
      env,
      ideCommand: resolved.ide?.command,
      noIde,
      noAttach,
    });

    yield* logger.success(`Environment ready for '${branch}'`);
  });
}

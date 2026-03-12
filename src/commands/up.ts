import { basename } from "node:path";
import { Console, Effect } from "effect";
import { loadConfig } from "../config/loader";
import type { WctServices } from "../effect/services";
import { commandError, toWctError, type WctError } from "../errors";
import { IdeService } from "../services/ide-service";
import { formatSessionName, TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import type { WctEnv } from "../types/env";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "up",
  description: "Start tmux session and open IDE in current directory",
  options: [
    {
      name: "no-ide",
      type: "boolean",
      description: "Skip opening IDE",
    },
  ],
};

export interface UpOptions {
  noIde?: boolean;
}

export function upCommand(
  options?: UpOptions,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const { noIde } = options ?? {};
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

    const sessionName = formatSessionName(basename(cwd));

    const env: WctEnv = {
      WCT_WORKTREE_DIR: cwd,
      WCT_MAIN_DIR: mainRepoPath,
      WCT_BRANCH: branch,
      WCT_PROJECT: config.project_name,
    };

    const ideCommand = config.ide?.command;
    yield* Effect.all([
      config.tmux
        ? logger
            .info("Creating tmux session...")
            .pipe(
              Effect.andThen(
                Effect.catch(
                  TmuxService.use((service) =>
                    service.createSession(sessionName, cwd, config.tmux, env),
                  ).pipe(
                    Effect.tap((tmuxResult) =>
                      tmuxResult._tag === "AlreadyExists"
                        ? logger.info(
                            `Tmux session '${sessionName}' already exists`,
                          )
                        : logger.success(
                            `Created tmux session '${sessionName}'`,
                          ),
                    ),
                  ),
                  (error) =>
                    logger.warn(
                      `Failed to create tmux session: ${toWctError(error).message}`,
                    ),
                ),
              ),
            )
        : Effect.void,
      ideCommand && !noIde
        ? logger
            .info("Opening IDE...")
            .pipe(
              Effect.andThen(
                Effect.catch(
                  IdeService.use((service) =>
                    service.openIDE(ideCommand, env),
                  ).pipe(Effect.tap(() => logger.success("IDE opened"))),
                  (error) =>
                    logger.warn(
                      `Failed to open IDE: ${toWctError(error).message}`,
                    ),
                ),
              ),
            )
        : Effect.void,
    ]);

    yield* logger.success(`Environment ready for '${branch}'`);
    if (config.tmux) {
      if (process.env.TMUX) {
        yield* Effect.catch(
          TmuxService.use((service) => service.switchSession(sessionName)).pipe(
            Effect.tap(() =>
              logger.success(`Switched to tmux session '${sessionName}'`),
            ),
          ),
          (error) =>
            logger.warn(
              `Failed to switch session: ${toWctError(error).message}`,
            ),
        );
      } else {
        yield* Console.log(
          `\nAttach to tmux session: ${logger.bold(`tmux attach -t ${sessionName}`)}`,
        );
      }
    }
  });
}

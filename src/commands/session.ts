import { Console, Effect } from "effect";
import type { TmuxConfig } from "../config/schema";
import type { WctServices } from "../effect/services";
import { toWctError, type WctError } from "../errors";
import { IdeService } from "../services/ide-service";
import { TmuxService } from "../services/tmux";
import type { WctEnv } from "../types/env";
import * as logger from "../utils/logger";

export function launchSessionAndIde(opts: {
  sessionName: string;
  workingDir: string;
  tmuxConfig?: TmuxConfig;
  env: WctEnv;
  ideCommand?: string;
  noIde?: boolean;
}): Effect.Effect<void, WctError, WctServices> {
  const { sessionName, workingDir, tmuxConfig, env, ideCommand, noIde } = opts;

  return Effect.gen(function* () {
    const [tmuxResult] = yield* Effect.all([
      tmuxConfig
        ? logger
            .info("Creating tmux session...")
            .pipe(
              Effect.andThen(
                Effect.catch(
                  TmuxService.use((service) =>
                    service.createSession(
                      sessionName,
                      workingDir,
                      tmuxConfig,
                      env,
                    ),
                  ).pipe(
                    Effect.tap((result) =>
                      result._tag === "AlreadyExists"
                        ? logger.info(
                            `Tmux session '${sessionName}' already exists`,
                          )
                        : logger.success(
                            `Created tmux session '${sessionName}'`,
                          ),
                    ),
                  ),
                  (error) =>
                    logger
                      .warn(
                        `Failed to create tmux session: ${toWctError(error).message}`,
                      )
                      .pipe(Effect.as(null)),
                ),
              ),
            )
        : Effect.succeed(null),
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

    if (tmuxResult) {
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

import { Console, Effect } from "effect";
import type { TmuxConfig } from "../config/schema";
import type { WctServices } from "../effect/services";
import { toWctError, type WctError } from "../errors";
import { IdeService } from "../services/ide-service";
import { TmuxService } from "../services/tmux";
import type { WctEnv } from "../types/env";
import * as logger from "../utils/logger";

function canAutoAttachTmux() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function maybeAttachSession(
  sessionName: string,
  noAttach?: boolean,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    if (noAttach || !canAutoAttachTmux()) {
      yield* Console.log(
        `\nAttach to tmux session: ${logger.bold(`tmux attach -t ${sessionName}`)}`,
      );
      return;
    }

    if (process.env.TMUX) {
      yield* Effect.catch(
        TmuxService.use((service) => service.switchSession(sessionName)).pipe(
          Effect.tap(() =>
            logger.success(`Switched to tmux session '${sessionName}'`),
          ),
        ),
        (error) =>
          logger.warn(`Failed to switch session: ${toWctError(error).message}`),
      );
      return;
    }

    yield* Console.log("");
    yield* logger.info(`Attaching to tmux session '${sessionName}'...`);
    yield* Effect.catch(
      TmuxService.use((service) => service.attachSession(sessionName)).pipe(
        Effect.tap(() =>
          logger.success(`Attached to tmux session '${sessionName}'`),
        ),
      ),
      (error) =>
        logger.warn(
          `Failed to attach session: ${toWctError(error).message}\nAttach manually with: ${logger.bold(`tmux attach -t ${sessionName}`)}`,
        ),
    );
  });
}

export function launchSessionAndIde(opts: {
  sessionName: string;
  workingDir: string;
  tmuxConfig?: TmuxConfig;
  env: WctEnv;
  ideCommand?: string;
  noIde?: boolean;
  noAttach?: boolean;
}): Effect.Effect<void, WctError, WctServices> {
  const {
    sessionName,
    workingDir,
    tmuxConfig,
    env,
    ideCommand,
    noIde,
    noAttach,
  } = opts;

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

    if (!tmuxResult) {
      return;
    }

    yield* maybeAttachSession(sessionName, noAttach);
  });
}

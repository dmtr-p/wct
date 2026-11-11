import { Config, Console, Effect, Result } from "effect";
import { loadRuntimeConfig } from "../effect/config";
import type { WctServices } from "../effect/services";
import { toWctError, type WctError } from "../errors";
import { TmuxService } from "../services/tmux";
import type { WorkspaceUpResult } from "../services/workspace-service";
import type { WctEnv } from "../types/env";
import * as logger from "../utils/logger";

function canAutoAttachTmux() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function maybeAttachSession(
  sessionName: string,
  noAttach?: boolean,
  env?: WctEnv,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const styles = yield* logger.stdoutStyles;
    if (noAttach || !canAutoAttachTmux()) {
      yield* Console.log(
        `\nAttach to tmux session: ${styles.bold(`tmux attach -t ${sessionName}`)}`,
      );
      return;
    }

    const resolution = yield* (
      env
        ? TmuxService.use((service) =>
            service.resolveSession({
              mainRepoPath: env.WCT_MAIN_DIR,
              worktreePath: env.WCT_WORKTREE_DIR,
              branch: env.WCT_BRANCH,
            }),
          )
        : Effect.succeed(null)
    ).pipe(Effect.result);
    const inspectionGuidance =
      "Inspect the tmux sessions and retry once Workspace ownership is verified.";
    if (Result.isFailure(resolution)) {
      yield* logger.warn(
        `Failed to resolve session: ${toWctError(resolution.failure).message}\n${inspectionGuidance}`,
      );
      return;
    }
    const id = resolution.success?.id;
    if (!id) {
      yield* logger.warn(
        `No verified tmux session ID is available for '${sessionName}'.\n${inspectionGuidance}`,
      );
      return;
    }
    const tmux = yield* loadRuntimeConfig(
      Config.String("TMUX").pipe(Config.withDefault("")),
    );
    if (tmux) {
      yield* Effect.catch(
        TmuxService.use((service) => service.switchSession(id)).pipe(
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
      TmuxService.use((service) => service.attachSession(id)).pipe(
        Effect.tap(() =>
          logger.success(`Attached to tmux session '${sessionName}'`),
        ),
      ),
      (error) =>
        logger.warn(
          `Failed to attach session: ${toWctError(error).message}\nAttach manually with: ${styles.bold(`tmux attach -t ${sessionName}`)}`,
        ),
    );
  });
}

export function logTmuxResult(
  result: Pick<WorkspaceUpResult, "sessionName" | "attempts">,
) {
  return Effect.gen(function* () {
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
  });
}

import { Console, Effect } from "effect";
import type { WctServices } from "../effect/services";
import { toWctError, type WctError } from "../errors";
import { TmuxService } from "../services/tmux";
import * as logger from "../utils/logger";

function canAutoAttachTmux() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function maybeAttachSession(
  sessionName: string,
  noAttach?: boolean,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const styles = yield* logger.stdoutStyles;
    if (noAttach || !canAutoAttachTmux()) {
      yield* Console.log(
        `\nAttach to tmux session: ${styles.bold(`tmux attach -t ${sessionName}`)}`,
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
          `Failed to attach session: ${toWctError(error).message}\nAttach manually with: ${styles.bold(`tmux attach -t ${sessionName}`)}`,
        ),
    );
  });
}

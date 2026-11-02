import { basename } from "node:path";
import { Config, Effect } from "effect";
import { loadRuntimeConfig } from "../effect/config";
import { commandError } from "../errors";
import { formatSessionName, TmuxService } from "../services/tmux";
import * as logger from "../utils/logger";
import { resolveWorktreeTarget } from "./worktree-target";

export { switchCommandDef as commandDef } from "../cli/command-metadata";

export function switchCommand(branch: string) {
  return Effect.gen(function* () {
    const worktree = yield* resolveWorktreeTarget(branch);

    const sessionName = formatSessionName(basename(worktree.path));
    const sessionPresent = yield* TmuxService.use((service) =>
      service.sessionExists(sessionName),
    );
    if (!sessionPresent) {
      return yield* commandError(
        "tmux_error",
        `No tmux session '${sessionName}' for branch '${branch}'. Try: wct up (from the worktree directory)`,
      );
    }

    const tmux = yield* loadRuntimeConfig(
      Config.String("TMUX").pipe(Config.withDefault("")),
    );
    if (tmux) {
      yield* TmuxService.use((service) => service.switchSession(sessionName));
      yield* logger.success(`Switched to session '${sessionName}'`);
      return;
    }

    yield* logger.info(`Attaching to session '${sessionName}'...`);

    yield* TmuxService.use((service) => service.attachSession(sessionName));
  });
}

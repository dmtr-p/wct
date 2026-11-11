import { Config, Effect } from "effect";
import { loadRuntimeConfig } from "../effect/config";
import { commandError } from "../errors";
import {
  canonicalSessionTarget,
  workspaceSessionName,
  workspaceSessionTarget,
} from "../services/session-identity";
import { TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import { resolveWorktreeTarget } from "./worktree-target";

export { switchCommandDef as commandDef } from "../cli/command-metadata";

export function switchCommand(branch: string) {
  return Effect.gen(function* () {
    const worktree = yield* resolveWorktreeTarget(branch);

    const mainRepoPath = yield* WorktreeService.use((service) =>
      service.getMainRepoPath(),
    );
    if (!mainRepoPath)
      return yield* commandError(
        "worktree_error",
        "Could not determine repository root",
      );
    const target = yield* canonicalSessionTarget(
      workspaceSessionTarget(mainRepoPath, worktree),
    );
    const session = yield* TmuxService.use((service) =>
      service.resolveSession(target),
    );
    const sessionName = session?.name ?? workspaceSessionName(target);
    const id = session?.id;
    if (!id) {
      return yield* commandError(
        "tmux_error",
        `No tmux session '${sessionName}' for branch '${branch}'. Try: wct up (from the worktree directory)`,
      );
    }

    const tmux = yield* loadRuntimeConfig(
      Config.String("TMUX").pipe(Config.withDefault("")),
    );
    if (tmux) {
      yield* TmuxService.use((service) => service.switchSession(id));
      yield* logger.success(`Switched to session '${sessionName}'`);
      return;
    }

    yield* logger.info(`Attaching to session '${sessionName}'...`);

    yield* TmuxService.use((service) => service.attachSession(id));
  });
}

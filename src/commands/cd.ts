import { Config, Effect } from "effect";
import { loadRuntimeConfig } from "../effect/config";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { spawnInteractive } from "../services/process";
import * as logger from "../utils/logger";
import { resolveWorktreeTarget } from "./worktree-target";

export { cdCommandDef as commandDef } from "../cli/command-metadata";

export function cdCommand(
  branch: string,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const worktree = yield* resolveWorktreeTarget(branch);

    const shell = yield* loadRuntimeConfig(
      Config.String("SHELL").pipe(Config.withDefault("/bin/sh")),
    );

    yield* logger.info(`Entering ${worktree.path} (exit to return)`);

    yield* Effect.mapError(
      spawnInteractive(shell, [], {
        cwd: worktree.path,
      }),
      (error) =>
        commandError(
          "worktree_error",
          `Failed to enter worktree '${worktree.path}'`,
          error,
        ),
    );
  });
}

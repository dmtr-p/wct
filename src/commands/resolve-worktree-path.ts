import { resolve } from "node:path";
import { Effect } from "effect";
import type { WctRuntimeServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { WorktreeService } from "../services/worktree-service";

export interface ResolveWorktreePathOptions {
  path?: string;
  branch?: string;
}

export function resolveWorktreePath(
  options: ResolveWorktreePathOptions,
): Effect.Effect<string, WctError, WctRuntimeServices> {
  return Effect.gen(function* () {
    const { path, branch } = options;

    if (path && branch) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "--path and --branch are mutually exclusive",
        ),
      );
    }

    if (path) return resolve(path);

    if (branch) {
      const match = yield* WorktreeService.use((service) =>
        service.findWorktreeByBranch(branch),
      );

      if (!match) {
        return yield* Effect.fail(
          commandError(
            "worktree_not_found",
            `No worktree found for branch '${branch}'`,
          ),
        );
      }

      return match.path;
    }

    return yield* Effect.try({
      try: () => process.cwd(),
      catch: (err) =>
        commandError(
          "unexpected_error",
          "Failed to resolve current working directory",
          err,
        ),
    });
  });
}

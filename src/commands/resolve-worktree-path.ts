import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { WorktreeService } from "../services/worktree-service";

export interface ResolveWorktreePathOptions {
  path?: string;
  branch?: string;
}

export function resolveWorktreePath(
  options: ResolveWorktreePathOptions,
): Effect.Effect<string, WctError, WctServices> {
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

    if (path) return path;

    if (branch) {
      const worktrees = yield* WorktreeService.use((service) =>
        service.listWorktrees(),
      );
      const match = worktrees.find((worktree) => worktree.branch === branch);

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

    return process.cwd();
  });
}

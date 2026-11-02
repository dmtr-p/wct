import { Effect } from "effect";
import { commandError, type WctError } from "../errors";
import { type Worktree, WorktreeService } from "../services/worktree-service";

export function resolveWorktreeTarget(
  branch: string,
): Effect.Effect<Worktree, WctError, WorktreeService> {
  return Effect.gen(function* () {
    const isRepo = yield* WorktreeService.use((service) => service.isGitRepo());
    if (!isRepo) {
      return yield* commandError("not_git_repo", "Not a git repository");
    }

    const worktree = yield* WorktreeService.use((service) =>
      service.findWorktreeByBranch(branch),
    );
    if (!worktree) {
      return yield* commandError(
        "worktree_not_found",
        `No worktree found for branch '${branch}'. Try: wct open ${branch}`,
      );
    }
    return worktree;
  });
}

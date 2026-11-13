import { resolve } from "node:path";
import { Effect } from "effect";
import { commandError } from "../errors";
import { getWctDir } from "./db";
import { execProcess } from "./process";
import {
  CurrentRepositoryLease,
  makeWorkspaceCoordinationService,
} from "./workspace-coordination";

export const makeRepositoryCoordinationService = (
  options: { root?: string } = {},
) =>
  makeWorkspaceCoordinationService({
    root: options.root ?? `${getWctDir()}-repository-coordination`,
  });

export function repositoryMutationTarget(cwd?: string) {
  return execProcess(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  ).pipe(
    Effect.map(({ stdout }) => ({
      mainRepoPath: resolve(stdout.trim()),
      branch: "repository-mutation",
    })),
    Effect.mapError((error) =>
      commandError(
        "worktree_error",
        "Cannot resolve repository mutation custody",
        error,
      ),
    ),
  );
}

/** Workspace custody precedes this scoped Git-only critical section. */
export function withRepositoryMutation<A, E, R>(
  cwd: string | undefined,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const target = yield* repositoryMutationTarget(cwd);
      const coordination = yield* makeRepositoryCoordinationService();
      const lease = yield* coordination
        .acquire(target)
        .pipe(
          Effect.mapError((error) =>
            commandError(
              "workspace_coordination_error",
              `Repository mutation blocked in '${target.mainRepoPath}': ${error.message} Inspect with wct operations inspect-repository --repo <checkout-or-git-directory>; reconcile-repository requires the exact operation/generation, acknowledgement and reason.`,
            ),
          ),
        );
      return yield* effect.pipe(
        Effect.provideService(CurrentRepositoryLease, lease),
      );
    }),
  );
}

import { join, resolve } from "node:path";
import { Effect } from "effect";
import { commandError } from "../errors";
import { execProcess } from "./process";
import {
  closeWorkspaceLock,
  openWorkspaceLock,
  tryWorkspaceLock,
} from "./workspace-lock";

/** Workspace custody precedes this short Git-only critical section. */
export function withRepositoryMutation<A, E, R>(
  cwd: string | undefined,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const common = yield* execProcess(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd },
      ).pipe(
        Effect.mapError((error) =>
          commandError(
            "worktree_error",
            "Cannot resolve repository mutation lock",
            error,
          ),
        ),
      );
      const descriptor = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            openWorkspaceLock(
              join(resolve(common.stdout.trim()), "wct-mutation.lock"),
            ),
          catch: (error) =>
            commandError(
              "worktree_error",
              "Cannot open repository mutation lock",
              error,
            ),
        }),
        (fd) => Effect.sync(() => closeWorkspaceLock(fd)),
      );
      while (
        !(yield* Effect.try({
          try: () => tryWorkspaceLock(descriptor),
          catch: (error) =>
            commandError(
              "worktree_error",
              "Cannot acquire repository mutation lock",
              error,
            ),
        }))
      )
        yield* Effect.sleep("25 millis");
      return yield* effect;
    }),
  );
}

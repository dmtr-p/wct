import { join, resolve } from "node:path";
import { Effect, FileSystem } from "effect";
import { commandError } from "../errors";

const PENDING_FILENAME = "wct-include-pending";

export function getIncludeCopyState(worktreePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const gitPath = join(worktreePath, ".git");
    const info = yield* Effect.catchIf(
      fs.stat(gitPath),
      (error) => error.reason._tag === "NotFound",
      () => Effect.void,
    );
    if (!info)
      return { pending: false, begin: Effect.void, complete: Effect.void };
    let gitDir = gitPath;
    if (info.type !== "Directory") {
      const pointer = yield* fs.readFileString(gitPath);
      if (!pointer.startsWith("gitdir: ")) {
        return yield* commandError(
          "worktree_error",
          `Invalid Git metadata pointer: ${gitPath}`,
        );
      }
      gitDir = resolve(worktreePath, pointer.slice(8).replace(/\r?\n$/, ""));
    }
    // Worktree-local Git metadata survives Open failures and is removed with
    // the worktree, without adding files to its checkout or Git status.
    const pendingPath = join(gitDir, PENDING_FILENAME);
    const pending = yield* fs.exists(pendingPath);
    const stateError = (error: unknown) =>
      commandError(
        "worktree_error",
        `Failed to save include copy state for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    return {
      pending,
      begin: fs
        .writeFileString(pendingPath, "pending\n")
        .pipe(Effect.mapError(stateError)),
      complete: fs
        .remove(pendingPath, { force: true })
        .pipe(Effect.mapError(stateError)),
    };
  }).pipe(
    Effect.mapError((error) =>
      commandError(
        "worktree_error",
        `Failed to read include copy state for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
    ),
  );
}

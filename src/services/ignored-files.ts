import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { commandError } from "../errors";
import { execProcess } from "./process";

export function discoverIgnoredFiles(sourceDir: string) {
  return Effect.gen(function* () {
    const discovered = yield* execProcess(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      { cwd: sourceDir },
    );
    const files: string[] = [];
    for (const path of new Set(discovered.stdout.split("\0"))) {
      if (
        !path ||
        path.startsWith("/") ||
        path
          .split("/")
          .some((part) => part === ".." || part.toLowerCase() === ".git")
      )
        continue;
      files.push(path);
    }
    return files;
  }).pipe(
    Effect.mapError((error) =>
      commandError(
        "worktree_error",
        `Failed to discover gitignored files in ${sourceDir}: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
    ),
  );
}

export function filterRegularFiles(
  files: ReadonlyArray<string>,
  sourceDir: string,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Effect.forEach(
      files,
      (file) =>
        fs
          .lstat(join(sourceDir, file))
          .pipe(
            Effect.map((info) => (info.type === "File" ? file : undefined)),
          ),
      { concurrency: 16 },
    );
    return paths.filter((path): path is string => path !== undefined);
  }).pipe(
    Effect.mapError((error) =>
      commandError("worktree_error", error.message, error),
    ),
  );
}

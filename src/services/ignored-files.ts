import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
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
  return Effect.forEach(
    files,
    (file) =>
      Effect.tryPromise({
        try: async () =>
          (await lstat(join(sourceDir, file))).isFile() ? file : undefined,
        catch: (error) =>
          commandError(
            "worktree_error",
            error instanceof Error ? error.message : String(error),
            error,
          ),
      }),
    { concurrency: 16 },
  ).pipe(
    Effect.map((paths) =>
      paths.filter((path): path is string => path !== undefined),
    ),
  );
}

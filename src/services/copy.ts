import { dirname, join, normalize } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { commandError } from "../errors";
import { discoverIgnoredFiles, filterRegularFiles } from "./ignored-files";

export interface CopyResult {
  file: string;
  success: boolean;
  error?: string;
}

export interface CopyEntrySkipped {
  entry: string;
  reason: "directory_not_found_or_empty" | "glob_no_matches";
}

export interface CopyEntryFailed {
  file: string;
  reason: "source_not_found" | "copy_failed";
  error: string;
}

export interface CopyReporter {
  entrySkipped?: (notice: CopyEntrySkipped) => Effect.Effect<void>;
  entryFailed?: (failure: CopyEntryFailed) => Effect.Effect<void>;
}

export type CopyEntryType = "file" | "directory" | "glob";

export function detectEntryType(entry: string): CopyEntryType {
  if (entry.endsWith("/")) return "directory";
  if (/[*?[\]{}]/.test(entry)) return "glob";
  return "file";
}

function expandDirectory(dirPath: string, baseDir: string) {
  const normalizedDir = dirPath.endsWith("/") ? dirPath.slice(0, -1) : dirPath;
  const fullPath = join(baseDir, normalizedDir);

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* Effect.orElseSucceed(fs.stat(fullPath), () => null);
    if (info?.type !== "Directory") {
      return [];
    }

    const files = yield* Effect.tryPromise({
      try: async () => {
        const glob = new Bun.Glob("**/*");
        const files: string[] = [];

        for await (const file of glob.scan({
          cwd: fullPath,
          onlyFiles: true,
          dot: true,
        })) {
          files.push(join(normalizedDir, file));
        }

        return files;
      },
      catch: (error) =>
        commandError(
          "worktree_error",
          error instanceof Error ? error.message : String(error),
          error,
        ),
    });
    return files;
  });
}

function expandGlob(pattern: string, baseDir: string) {
  return Effect.tryPromise({
    try: async () => {
      const glob = new Bun.Glob(pattern);
      const files: string[] = [];

      for await (const file of glob.scan({
        cwd: baseDir,
        onlyFiles: true,
        dot: true,
      })) {
        files.push(file);
      }

      return files;
    },
    catch: (error) =>
      commandError(
        "worktree_error",
        error instanceof Error ? error.message : String(error),
        error,
      ),
  });
}

export function expandEntry(entry: string, baseDir: string) {
  const entryType = detectEntryType(entry);

  switch (entryType) {
    case "directory":
      return expandDirectory(entry, baseDir);
    case "glob":
      return expandGlob(entry, baseDir);
    case "file":
      return Effect.succeed([entry]);
  }
}

export function copyEntries(
  entries: ReadonlyArray<string>,
  sourceDir: string,
  targetDir: string,
  reporter?: CopyReporter,
) {
  return Effect.gen(function* () {
    if (entries.length === 0) return [];
    const ignoredFiles = new Set(yield* discoverIgnoredFiles(sourceDir));
    const allFiles: string[] = [];

    for (const entry of entries) {
      const expanded = (yield* expandEntry(entry, sourceDir))
        .map((file) => normalize(file))
        .filter((file) => ignoredFiles.has(file));
      if (expanded.length === 0) {
        const entryType = detectEntryType(entry);
        if (entryType === "directory") {
          if (reporter?.entrySkipped) {
            yield* reporter.entrySkipped({
              entry,
              reason: "directory_not_found_or_empty",
            });
          }
        } else if (entryType === "glob") {
          if (reporter?.entrySkipped) {
            yield* reporter.entrySkipped({
              entry,
              reason: "glob_no_matches",
            });
          }
        }
      }
      allFiles.push(...expanded);
    }

    const uniqueFiles = [...new Set(allFiles)];

    const regularFiles = yield* filterRegularFiles(uniqueFiles, sourceDir);
    return yield* copyFiles(regularFiles, sourceDir, targetDir, reporter);
  });
}

export function copyFiles(
  files: ReadonlyArray<string>,
  sourceDir: string,
  targetDir: string,
  reporter?: CopyReporter,
) {
  return Effect.gen(function* () {
    const results: CopyResult[] = [];

    for (const file of files) {
      const sourcePath = join(sourceDir, file);
      const targetPath = join(targetDir, file);

      const result = yield* Effect.catch(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          if (!(yield* fs.exists(sourcePath))) {
            const failure = {
              file,
              reason: "source_not_found" as const,
              error: "File not found",
            };
            if (reporter?.entryFailed) {
              yield* reporter.entryFailed(failure);
            }
            return { file, success: false as const, error: failure.error };
          }

          const targetDirPath = dirname(targetPath);
          yield* fs.makeDirectory(targetDirPath, { recursive: true });

          yield* Effect.scoped(
            Effect.gen(function* () {
              const source = yield* fs.open(sourcePath, { flag: "r" });
              // Destination links can reference the source; defer truncation.
              const target = yield* fs.open(targetPath, { flag: "a" });
              const sourceInfo = yield* source.stat;
              const targetInfo = yield* target.stat;
              if (
                Option.isNone(sourceInfo.ino) ||
                Option.isNone(targetInfo.ino)
              )
                return yield* commandError(
                  "worktree_error",
                  "Unable to verify source and destination file identities",
                );
              if (
                sourceInfo.dev === targetInfo.dev &&
                sourceInfo.ino.value === targetInfo.ino.value
              )
                return;
              yield* target.truncate(0);
              const buffer = new Uint8Array(1024 * 1024);
              while (true) {
                const count = yield* source.read(buffer);
                if (count === 0) break;
                yield* target.writeAll(buffer.subarray(0, count));
              }
            }),
          );

          return { file, success: true as const };
        }),
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          const failure = {
            file,
            reason: "copy_failed" as const,
            error: message,
          };
          const result = { file, success: false as const, error: message };
          return reporter?.entryFailed
            ? reporter.entryFailed(failure).pipe(Effect.as(result))
            : Effect.succeed(result);
        },
      );

      results.push(result);
    }

    return results;
  });
}

import { dirname, join } from "node:path";
import { Effect, FileSystem } from "effect";

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
    const info = yield* Effect.catch(fs.stat(fullPath), () =>
      Effect.succeed(null),
    );
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
      catch: (error) => error,
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
    catch: (error) => error,
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
    const allFiles: string[] = [];

    for (const entry of entries) {
      const expanded = yield* expandEntry(entry, sourceDir);
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

    // Deduplicate files (in case of overlapping patterns)
    const uniqueFiles = [...new Set(allFiles)];

    return yield* copyFiles(uniqueFiles, sourceDir, targetDir, reporter);
  });
}

function copyFiles(
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

          const content = yield* fs.readFile(sourcePath);
          yield* fs.writeFile(targetPath, content);

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

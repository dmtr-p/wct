import { dirname, isAbsolute, join, normalize } from "node:path";
import { Effect, FileSystem, Glob, Option } from "effect";
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

export function expandEntry(
  entry: string,
  candidates: ReadonlySet<string>,
): string[] {
  if (isAbsolute(entry)) return [];
  const hasGlob = /[*?[\]{}]/.test(entry);
  if (!hasGlob && detectEntryType(entry) === "directory") {
    const directory = normalize(entry.replace(/^\\!/, "!")).replace(/\/+$/, "");
    const prefix = directory === "." ? "" : `${directory}/`;
    return [...candidates].filter((file) => file.startsWith(prefix));
  }
  if (!hasGlob) {
    const file = normalize(entry.replace(/^\\!/, "!"));
    return candidates.has(file) ? [file] : [];
  }
  // oxlint-disable effecttsgo/experimental-api-usage -- Use one glob syntax for both copy selection and exclusions.
  const glob = Glob.make(entry.endsWith("/") ? `${entry}**/*` : entry, {
    dot: true,
  });
  return [...candidates].filter((file) => Glob.match(glob, file));
  // oxlint-enable effecttsgo/experimental-api-usage
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
    const selected = new Set<string>();

    for (const entry of entries) {
      const excluded = entry.startsWith("!");
      const expanded = expandEntry(
        excluded ? entry.slice(1) : entry,
        excluded ? selected : ignoredFiles,
      );
      if (excluded) {
        for (const file of expanded) selected.delete(file);
        continue;
      }
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
      for (const file of expanded) selected.add(file);
    }

    const missing: CopyResult[] = [];
    const regularFiles = yield* filterRegularFiles(
      [...selected],
      sourceDir,
      (file) =>
        missingSource(file, reporter).pipe(
          Effect.tap((result) => Effect.sync(() => missing.push(result))),
          Effect.asVoid,
        ),
    );
    const copied = yield* copyFiles(
      regularFiles,
      sourceDir,
      targetDir,
      reporter,
    );
    return [...copied, ...missing];
  });
}

function missingSource(file: string, reporter?: CopyReporter) {
  const failure = {
    file,
    reason: "source_not_found" as const,
    error: "File not found",
  };
  const result = { file, success: false as const, error: failure.error };
  return reporter?.entryFailed
    ? reporter.entryFailed(failure).pipe(Effect.as(result))
    : Effect.succeed(result);
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
            return yield* missingSource(file, reporter);
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

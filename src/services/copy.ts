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

/** Selects entry matches from Git's ignored files instead of walking the disk. */
export function expandEntry(
  entry: string,
  candidates: ReadonlySet<string>,
): string[] {
  const path = normalize(entry);
  switch (detectEntryType(entry)) {
    case "file":
      return candidates.has(path) ? [path] : [];
    case "directory": {
      const directory = path.replace(/\/+$/, "");
      const prefix = directory === "." ? "" : `${directory}/`;
      return [...candidates].filter((file) => file.startsWith(prefix));
    }
    case "glob": {
      const glob = new Bun.Glob(path);
      return [...candidates].filter((file) => glob.match(file));
    }
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
    const selected = new Set<string>();

    for (const entry of entries) {
      const expanded = expandEntry(entry, ignoredFiles);
      const entryType = detectEntryType(entry);
      if (expanded.length === 0 && entryType !== "file") {
        yield* reporter?.entrySkipped?.({
          entry,
          reason:
            entryType === "directory"
              ? "directory_not_found_or_empty"
              : "glob_no_matches",
        }) ?? Effect.void;
      }
      for (const file of expanded) selected.add(file);
    }

    const regularFiles = yield* filterRegularFiles([...selected], sourceDir);
    return yield* copyFiles(regularFiles, sourceDir, targetDir, reporter);
  });
}

function reportCopyFailure(
  file: string,
  reason: CopyEntryFailed["reason"],
  error: string,
  reporter?: CopyReporter,
) {
  const failure = {
    file,
    reason,
    error,
  };
  const result = { file, success: false as const, error };
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
    if (files.length === 0) return [];
    const results: CopyResult[] = [];
    const buffer = new Uint8Array(1024 * 1024);

    for (const file of files) {
      const sourcePath = join(sourceDir, file);
      const targetPath = join(targetDir, file);

      const result = yield* Effect.catch(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const source = yield* fs.open(sourcePath, { flag: "r" }).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.undefined,
              ),
            );
            if (!source) {
              return yield* reportCopyFailure(
                file,
                "source_not_found",
                "File not found",
                reporter,
              );
            }

            const targetDirPath = dirname(targetPath);
            yield* fs.makeDirectory(targetDirPath, { recursive: true });
            // Destination links can reference the source; defer truncation.
            const target = yield* fs.open(targetPath, { flag: "a" });
            const sourceInfo = yield* source.stat;
            const targetInfo = yield* target.stat;
            if (Option.isNone(sourceInfo.ino) || Option.isNone(targetInfo.ino))
              return yield* commandError(
                "worktree_error",
                "Unable to verify source and destination file identities",
              );
            if (
              sourceInfo.dev === targetInfo.dev &&
              sourceInfo.ino.value === targetInfo.ino.value
            )
              return { file, success: true as const };
            yield* target.truncate(0);
            while (true) {
              const count = yield* source.read(buffer);
              if (count === 0) break;
              yield* target.writeAll(buffer.subarray(0, count));
            }
            return { file, success: true as const };
          }),
        ),
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          return reportCopyFailure(file, "copy_failed", message, reporter);
        },
      );

      results.push(result);
    }

    return results;
  });
}

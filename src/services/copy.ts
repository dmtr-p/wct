import { dirname, isAbsolute, join, normalize } from "node:path";
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
  reason:
    "directory_not_found_or_empty" | "glob_no_matches" | "exclusion_no_matches";
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
  if (/[*?[\]{}]/.test(entry)) return "glob";
  if (entry.endsWith("/")) return "directory";
  return "file";
}

export function parseEntry(entry: string) {
  const excluded = entry.startsWith("!");
  const value = excluded ? entry.slice(1) : entry;
  const entryType = detectEntryType(value);
  const normalized = normalize(
    entryType === "glob" ? value : value.replace(/^\\!/, "!"),
  );
  // Bun.Glob negates a leading `!`; markers are already consumed above.
  const pattern =
    entryType === "glob" && normalized.startsWith("!")
      ? `\\${normalized}`
      : normalized;
  // Directory names may contain glob syntax, so also match the literal path.
  const literalDirectory =
    entryType === "glob" && normalized.endsWith("/") ? normalized : undefined;
  // An empty prefix indexes root files; undefined leaves the pattern unrestricted.
  let prefix: string | undefined;
  if (entryType === "directory") {
    const directory = pattern.replace(/\/+$/, "");
    prefix = directory === "." ? undefined : `${directory}/`;
  } else if (entryType === "glob") {
    // Stop before escapes too, so a literal prefix never includes glob syntax.
    const literal = pattern.slice(0, pattern.search(/[*?[\]{}\\]/));
    const slash = literal.lastIndexOf("/");
    if (slash !== -1) prefix = literal.slice(0, slash + 1);
    else if (!pattern.includes("/") && !pattern.includes("**")) prefix = "";
  }
  return {
    entry,
    excluded,
    entryType,
    pattern,
    prefix,
    literalDirectory,
    absolute: isAbsolute(value),
  };
}

type ParsedEntry = ReturnType<typeof parseEntry>;

function indexDirectories(
  entries: ReadonlyArray<ParsedEntry>,
  files: ReadonlySet<string>,
) {
  const directories = new Map<string, string[]>();
  for (const { absolute, prefix } of entries) {
    if (absolute) continue;
    if (prefix !== undefined) directories.set(prefix, []);
  }
  if (directories.size === 0) return directories;
  for (const file of files) {
    if (!file.includes("/")) directories.get("")?.push(file);
    for (
      let slash = file.indexOf("/");
      slash !== -1;
      slash = file.indexOf("/", slash + 1)
    ) {
      directories.get(file.slice(0, slash + 1))?.push(file);
    }
  }
  return directories;
}

export function expandEntry(
  entry: ParsedEntry,
  candidates: ReadonlySet<string>,
  directories?: ReadonlyMap<string, ReadonlyArray<string>>,
): string[] {
  if (entry.absolute) return [];
  const { entryType, pattern, prefix, literalDirectory } = entry;
  if (entryType === "file") {
    return candidates.has(pattern) ? [pattern] : [];
  }
  let matches: (file: string) => boolean;
  if (entryType === "directory") {
    matches = (file) => file.startsWith(prefix ?? "");
  } else {
    const glob = new Bun.Glob(
      pattern.endsWith("/") ? `${pattern}**/*` : pattern,
    );
    matches = (file) =>
      glob.match(file) ||
      (literalDirectory !== undefined && file.startsWith(literalDirectory));
  }
  const expanded: string[] = [];
  const scoped = prefix === undefined ? undefined : directories?.get(prefix);
  for (const file of scoped ?? candidates) {
    if (candidates.has(file) && matches(file)) expanded.push(file);
  }
  return expanded;
}

export function copyEntries(
  entries: ReadonlyArray<string>,
  sourceDir: string,
  targetDir: string,
  reporter?: CopyReporter,
) {
  return Effect.gen(function* () {
    const rules = entries.map(parseEntry);
    if (rules.every((rule) => rule.excluded)) {
      for (const { entry } of rules) {
        if (reporter?.entrySkipped) {
          yield* reporter.entrySkipped({
            entry,
            reason: "exclusion_no_matches",
          });
        }
      }
      return [];
    }
    const ignoredFiles = new Set(yield* discoverIgnoredFiles(sourceDir));
    const directories = indexDirectories(rules, ignoredFiles);
    const selected = new Set<string>();

    for (const rule of rules) {
      const { entry, excluded, entryType } = rule;
      const expanded = expandEntry(
        rule,
        excluded ? selected : ignoredFiles,
        directories,
      );
      if (excluded) {
        if (expanded.length === 0 && reporter?.entrySkipped) {
          yield* reporter.entrySkipped({
            entry,
            reason: "exclusion_no_matches",
          });
        }
        for (const file of expanded) selected.delete(file);
        continue;
      }
      if (expanded.length === 0) {
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

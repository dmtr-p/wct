import { dirname, join } from "node:path";
import { Effect } from "effect";
import * as logger from "../utils/logger";
import {
  ensureDirectory,
  isDirectory,
  listFilesRecursive,
  pathExists,
  readBytes,
  writeBytes,
} from "./filesystem";

export interface CopyResult {
  file: string;
  success: boolean;
  error?: string;
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
    if (!(yield* isDirectory(fullPath))) {
      return [];
    }

    const files = yield* listFilesRecursive(fullPath);
    return files.map((file) => join(normalizedDir, file));
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
) {
  return Effect.gen(function* () {
    const allFiles: string[] = [];

    for (const entry of entries) {
      const expanded = yield* expandEntry(entry, sourceDir);
      if (expanded.length === 0) {
        const entryType = detectEntryType(entry);
        if (entryType === "directory") {
          yield* logger.warn(`Directory not found or empty: ${entry}`);
        } else if (entryType === "glob") {
          yield* logger.warn(`No files matched pattern: ${entry}`);
        }
      }
      allFiles.push(...expanded);
    }

    // Deduplicate files (in case of overlapping patterns)
    const uniqueFiles = [...new Set(allFiles)];

    return yield* copyFiles(uniqueFiles, sourceDir, targetDir);
  });
}

function copyFiles(
  files: ReadonlyArray<string>,
  sourceDir: string,
  targetDir: string,
) {
  return Effect.gen(function* () {
    const results: CopyResult[] = [];

    for (const file of files) {
      const sourcePath = join(sourceDir, file);
      const targetPath = join(targetDir, file);

      const result = yield* Effect.catch(
        Effect.gen(function* () {
          if (!(yield* pathExists(sourcePath))) {
            yield* logger.warn(`File not found: ${file}`);
            return { file, success: false as const, error: "File not found" };
          }

          const targetDirPath = dirname(targetPath);
          yield* ensureDirectory(targetDirPath);

          const content = yield* readBytes(sourcePath);
          yield* writeBytes(targetPath, content);

          return { file, success: true as const };
        }),
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          return logger
            .warn(`Failed to copy ${file}: ${message}`)
            .pipe(Effect.as({ file, success: false as const, error: message }));
        },
      );

      results.push(result);
    }

    return results;
  });
}

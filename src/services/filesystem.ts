import { stat as nodeStat } from "node:fs/promises";
import { join } from "node:path";
import { Effect, FileSystem } from "effect";

export function pathExists(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(path);
  });
}

export function isDirectory(path: string) {
  return Effect.catch(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(path);
      return info.type === "Directory";
    }),
    () => Effect.succeed(false),
  );
}

export function readText(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path);
  });
}

export function readBytes(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFile(path);
  });
}

export function writeText(path: string, data: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(path, data);
  });
}

export function writeBytes(path: string, data: ArrayBuffer | Uint8Array) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFile(path, bytes);
  });
}

export function ensureDirectory(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path, { recursive: true });
  });
}

export function removePath(
  path: string,
  options?: {
    recursive?: boolean;
    force?: boolean;
  },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path, options);
  });
}

export function copyPath(
  fromPath: string,
  toPath: string,
  options?: {
    overwrite?: boolean;
    preserveTimestamps?: boolean;
  },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.copy(fromPath, toPath, options);
  });
}

export function listFilesRecursive(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(path, { recursive: true });
    const files: string[] = [];

    for (const entry of entries) {
      const info = yield* Effect.catch(fs.stat(join(path, entry)), () =>
        Effect.succeed(null),
      );

      if (info?.type === "File") {
        files.push(entry);
      }
    }

    return files;
  });
}

export function statBigint(path: string) {
  return Effect.tryPromise({
    try: () => nodeStat(path, { bigint: true }),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
}

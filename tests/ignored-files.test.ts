import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import {
  ByteSize,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  PlatformError,
} from "effect";
import { expect } from "vitest";
import { filterRegularFiles } from "../src/services/ignored-files";

function info(type: FileSystem.File.Type): FileSystem.File.Info {
  return {
    type,
    mtime: Option.none(),
    atime: Option.none(),
    birthtime: Option.none(),
    dev: 0n,
    ino: Option.none(),
    mode: 0,
    nlink: Option.none(),
    uid: Option.none(),
    gid: Option.none(),
    rdev: Option.none(),
    size: ByteSize.bytes(0),
    blksize: Option.none(),
    blocks: Option.none(),
  };
}

describe("ignored file inspection", () => {
  it.effect(
    "uses the filesystem override and excludes links and nonregular files",
    () =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const types = [
          "File",
          "SymbolicLink",
          "Directory",
          "FIFO",
          "File",
        ] as const;
        const files = types.map((_, index) => `file-${index}`);
        const fs = FileSystem.makeNoop({
          lstat: (path) =>
            Effect.sync(() => {
              paths.push(path);
              return info(types[Number(path.split("-").at(-1))] ?? "Unknown");
            }),
        });
        const selected = yield* filterRegularFiles(files, "/source").pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        expect(selected).toEqual(["file-0", "file-4"]);
        expect(paths).toEqual(files.map((file) => join("/source", file)));
      }),
  );

  it.effect(
    "maps lstat failures to worktree_error with the original cause",
    () =>
      Effect.gen(function* () {
        const failure = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "lstat",
          pathOrDescriptor: "/source/secret",
        });
        const error = yield* filterRegularFiles(["secret"], "/source").pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              lstat: () => Effect.fail(failure),
            }),
          ),
          Effect.flip,
        );
        expect(error).toMatchObject({
          code: "worktree_error",
          message: failure.message,
          cause: failure,
        });
      }),
  );

  it.effect("keeps defects visible through typed error mapping", () =>
    Effect.gen(function* () {
      const defect = new Error("broken filesystem implementation");
      const exit = yield* filterRegularFiles(["secret"], "/source").pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ lstat: () => Effect.die(defect) }),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
    }),
  );

  it.effect("bounds concurrent lstat calls and preserves selection order", () =>
    Effect.gen(function* () {
      const saturated = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let peak = 0;
      const fs = FileSystem.makeNoop({
        lstat: () =>
          Effect.gen(function* () {
            active++;
            peak = Math.max(peak, active);
            if (active === 16) yield* Deferred.succeed(saturated, undefined);
            yield* Deferred.await(release);
            return info("File");
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active--;
              }),
            ),
          ),
      });
      const files = Array.from({ length: 40 }, (_, i) => `file-${i}`);
      const fiber = yield* filterRegularFiles(files, "/source").pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.forkChild,
      );
      yield* Deferred.await(saturated);
      expect(active).toBe(16);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(fiber)).toEqual(files);
      expect(peak).toBe(16);
      expect(active).toBe(0);
    }),
  );
});

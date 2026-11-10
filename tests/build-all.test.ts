import { it } from "@effect/vitest";
import {
  ByteSize,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Sink,
  Stream,
} from "effect";
import { Digest } from "effect/crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestConsole } from "effect/testing";
import { describe, expect } from "vitest";
import { buildAll } from "../scripts/build-all";

function fixture(failTarget?: string) {
  const commands: ChildProcess.StandardCommand[] = [];
  const writes = new Map<string, string>();
  const reads: string[] = [];
  let active = 0;
  let peak = 0;
  let released = 0;
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command))
      return Effect.die(new Error("Expected a direct build command"));
    return Effect.acquireRelease(
      Effect.sync(() => {
        commands.push(command);
        active++;
        peak = Math.max(peak, active);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(commands.length),
          exitCode: Effect.succeed(
            ChildProcessSpawner.ExitCode(
              command.args.includes(failTarget ?? "") ? 7 : 0,
            ),
          ),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
      () =>
        Effect.sync(() => {
          active--;
          released++;
        }),
    );
  });
  const fs = FileSystem.makeNoop({
    makeDirectory: () => Effect.void,
    stat: () =>
      Effect.sync((): FileSystem.File.Info => {
        reads.push("stat");
        return {
          type: "File",
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
          size: ByteSize.bytes(64 * 1024 * 1024),
          blksize: Option.none(),
          blocks: Option.none(),
        };
      }),
    readFile: () =>
      Effect.sync(() => {
        reads.push("read");
        return new TextEncoder().encode("abc");
      }),
    writeFileString: (path, content) =>
      Effect.sync(() => {
        writes.set(path, content);
      }),
  });
  return {
    commands,
    writes,
    reads,
    resources: () => ({ active, peak, released }),
    run: buildAll.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(Layer.mergeAll(Digest.layerWebCrypto, Path.layer)),
    ),
  };
}

describe("release builds", () => {
  it.effect(
    "builds sequentially and writes SHA-256 checksums for every artifact",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.run;
        expect(f.commands.map((command) => command.args[4])).toEqual([
          "bun-darwin-x64",
          "bun-darwin-arm64",
          "bun-linux-x64",
          "bun-linux-arm64",
        ]);
        for (const command of f.commands) {
          expect(command.command).toBe(process.execPath);
          expect(command.options).toMatchObject({
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
          });
        }
        const hash =
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        expect([...f.writes.keys()]).toEqual([
          expect.stringMatching(/\/dist\/checksums\.txt$/),
        ]);
        expect([...f.writes.values()]).toEqual([
          `${hash}  wct-darwin-x64\n${hash}  wct-darwin-arm64\n${hash}  wct-linux-x64\n${hash}  wct-linux-arm64\n`,
        ]);
        expect(f.resources()).toEqual({ active: 0, peak: 1, released: 4 });
        expect(f.reads).toEqual([
          "stat",
          "read",
          "stat",
          "read",
          "stat",
          "read",
          "stat",
          "read",
        ]);
        expect(yield* TestConsole.logLines).toContain(
          "  ✓ Built wct-darwin-x64 (64.00 MB)",
        );
      }),
  );

  it.effect(
    "stops at a failed compiler and leaves the checksum manifest unwritten",
    () =>
      Effect.gen(function* () {
        const f = fixture("bun-darwin-arm64");
        const error = yield* Effect.flip(f.run);
        expect(error.message).toContain("Failed to build wct-darwin-arm64");
        expect(error.message).not.toContain("Build failed: Failed to build");
        expect(error.message).toContain("Command exited with code 7");
        expect(f.commands).toHaveLength(2);
        expect(f.writes.size).toBe(0);
        expect(f.resources()).toEqual({ active: 0, peak: 1, released: 2 });
      }),
  );
});

import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Sink, Stream } from "effect";
import { Digest } from "effect/crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vitest";
import { buildAll } from "../scripts/build-all";

function fixture(failTarget?: string) {
  const commands: ChildProcess.StandardCommand[] = [];
  const writes = new Map<string, string>();
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
    readFile: () => Effect.succeed(new TextEncoder().encode("abc")),
    writeFileString: (path, content) =>
      Effect.sync(() => {
        writes.set(path, content);
      }),
  });
  return {
    commands,
    writes,
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
      }),
  );

  it.effect(
    "stops at a failed compiler and leaves the checksum manifest unwritten",
    () =>
      Effect.gen(function* () {
        const f = fixture("bun-darwin-arm64");
        const error = yield* Effect.flip(f.run);
        expect(error.message).toContain("Failed to build wct-darwin-arm64");
        expect(error.message).toContain("Command exited with code 7");
        expect(f.commands).toHaveLength(2);
        expect(f.writes.size).toBe(0);
        expect(f.resources()).toEqual({ active: 0, peak: 1, released: 2 });
      }),
  );
});

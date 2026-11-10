import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Result, Stream } from "effect";
import { describe, expect, test } from "vitest";
import {
  foregroundProcesses,
  inspectForegroundAgent,
  parseProcessSnapshot,
  parsePsArgv,
  readProcArguments,
} from "../../src/services/agent-process";

describe("foreground process identity", () => {
  const snapshot = parseProcessSnapshot(
    " 10 1 10 20 ttys001 Ss Thu Oct 9 12:00:00 2026 /bin/fish\n 20 10 20 20 ttys001 S+ Thu Oct 9 12:00:01 2026 /usr/bin/codex\n 30 10 30 20 ttys001 S Thu Oct 9 12:00:02 2026 claude\n",
  );
  const agentProcess = snapshot[1];
  if (!agentProcess) throw new Error("Missing foreground process fixture");
  test("uses the TTY foreground group rather than the initial shell or background descendants", () => {
    expect(snapshot).toHaveLength(3);
    expect(
      foregroundProcesses(snapshot, "/dev/ttys001").map(
        (process) => process.pid,
      ),
    ).toEqual([20]);
    expect(inspectForegroundAgent(snapshot, "/dev/ttys001")).toEqual({
      kind: "identified",
      agent: "codex",
      generation: "20:Thu Oct 9 12:00:01 2026:20",
    });
    expect(inspectForegroundAgent(snapshot, "/dev/ttys002")).toEqual({
      kind: "unrecognized",
    });
    expect(
      inspectForegroundAgent(
        snapshot.map((process) => ({ ...process, stat: "T" })),
        "/dev/ttys001",
      ),
    ).toEqual({ kind: "unrecognized" });
  });
  test("supports Linux TTY names and official runtime entrypoints", () => {
    const process = {
      ...agentProcess,
      tty: "pts/4",
      command: "node",
      argv: ["node", "/app/node_modules/@openai/codex/bin/codex.js"],
    };
    expect(inspectForegroundAgent([process], "/dev/pts/4")).toEqual({
      kind: "identified",
      agent: "codex",
      generation: "20:Thu Oct 9 12:00:01 2026:20",
    });
    expect(
      inspectForegroundAgent(
        [{ ...process, argv: ["node", "server.js", "codex"] }],
        "/dev/pts/4",
      ),
    ).toEqual({ kind: "unrecognized" });
  });
  test("runtime/native children count once, independent competing agents remain unresolved", () => {
    const parent = {
      ...agentProcess,
      command: "node",
      argv: ["node", "/app/node_modules/@openai/codex/bin/codex.js"],
    };
    const child = { ...agentProcess, pid: 21, ppid: 20 };
    expect(inspectForegroundAgent([parent, child], "/dev/ttys001")).toEqual({
      kind: "identified",
      agent: "codex",
      generation: "20:Thu Oct 9 12:00:01 2026:20",
    });
    expect(
      inspectForegroundAgent([parent, { ...child, ppid: 10 }], "/dev/ttys001"),
    ).toEqual({ kind: "ambiguous" });
    expect(
      inspectForegroundAgent([{ ...parent, argv: [] }], "/dev/ttys001"),
    ).toEqual({ kind: "unrecognized" });
  });
  test("rejects ambiguous macOS ps quoting and keeps argv-only identification strict", () => {
    const args = parsePsArgv(
      '20 node /app/node_modules/@openai/codex/bin/codex.js\n21 node "path with spaces"\n',
    );
    expect(args.get(20)?.[1]).toContain("@openai/codex");
    expect(args.has(21)).toBe(false);
  });
});

describe("Linux runtime arguments", () => {
  it.effect(
    "decodes NUL-delimited arguments across UTF-8 chunk boundaries",
    () =>
      Effect.gen(function* () {
        const content = new TextEncoder().encode("bun\0/app/café.js\0--flag\0");
        const split = content.indexOf(0xc3) + 1;
        let closed = false;
        const fs = FileSystem.makeNoop({
          stream: () =>
            Stream.fromIterable([
              content.slice(0, split),
              content.slice(split),
            ]).pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  closed = true;
                }),
              ),
            ),
        });
        const argv = yield* readProcArguments(20).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        expect(argv).toEqual(["bun", "/app/café.js", "--flag"]);
        expect(closed).toBe(true);
      }),
  );

  it.effect.each([64 * 1024, 64 * 1024 + 1])(
    "bounds argument reads at 64 KiB and closes the stream for %i bytes",
    (size) =>
      Effect.gen(function* () {
        let closed = false;
        const fs = FileSystem.makeNoop({
          stream: () =>
            Stream.succeed(new Uint8Array(size).fill(97)).pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  closed = true;
                }),
              ),
            ),
        });
        const result = yield* readProcArguments(20).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.result,
        );
        if (size === 64 * 1024) {
          expect(Result.isSuccess(result)).toBe(true);
          if (Result.isSuccess(result))
            expect(result.success).toEqual(["a".repeat(size)]);
        } else {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure.message).toBe("Argument limit exceeded");
        }
        expect(closed).toBe(true);
      }),
  );

  it.effect("closes a pending argument stream when interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const fs = FileSystem.makeNoop({
        stream: () =>
          Stream.fromEffect(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          ).pipe(Stream.ensuring(Deferred.succeed(closed, undefined))),
      });
      const fiber = yield* readProcArguments(20).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(closed);
    }),
  );
});

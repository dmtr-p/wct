import { it } from "@effect/vitest";
import { Console, Effect, Stdio } from "effect";
import { TestConsole } from "effect/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonError, jsonSuccess } from "../src/utils/json-output";

describe("JSON output", { concurrent: false }, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test.each([undefined, "", "1"])(
    "JSON envelopes stay unstyled on terminal streams with NO_COLOR=%s",
    (noColor) => {
      vi.stubEnv("NO_COLOR", noColor);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const capturedConsole: Console.Console = {
        ...console,
        log: (message) => stdout.push(String(message)),
        error: (message) => stderr.push(String(message)),
      };

      Effect.runSync(
        Effect.gen(function* () {
          yield* jsonSuccess({ branch: "main" });
          yield* jsonError("worktree_error", "Not found");
        }).pipe(
          Effect.provideService(Console.Console, capturedConsole),
          Effect.provide(
            Stdio.layerTest({
              stdoutIsTerminal: Effect.succeed(true),
              stderrIsTerminal: Effect.succeed(true),
            }),
          ),
        ),
      );

      expect(stdout).toHaveLength(1);
      expect(stderr).toHaveLength(1);
      expect(JSON.parse(stdout[0] as string)).toEqual({
        ok: true,
        data: { branch: "main" },
      });
      expect(JSON.parse(stderr[0] as string)).toEqual({
        ok: false,
        error: { code: "worktree_error", message: "Not found" },
      });
      expect([...stdout, ...stderr].join("\n")).not.toContain("\x1b");
    },
  );

  describe("jsonSuccess", () => {
    it.effect("writes JSON envelope with ok:true to stdout", () =>
      Effect.gen(function* () {
        yield* jsonSuccess({ branch: "main", changes: 3 });
        const lines = yield* TestConsole.logLines;
        expect(lines).toHaveLength(1);
        const output = JSON.parse(lines[0] as string);
        expect(output).toEqual({
          ok: true,
          data: { branch: "main", changes: 3 },
        });
        expect(yield* TestConsole.errorLines).toEqual([]);
      }),
    );

    it.effect("outputs valid JSON for arrays", () =>
      Effect.gen(function* () {
        yield* jsonSuccess([1, 2, 3]);
        const lines = yield* TestConsole.logLines;
        expect(lines).toHaveLength(1);
        const output = JSON.parse(lines[0] as string);
        expect(output).toEqual({ ok: true, data: [1, 2, 3] });
        expect(yield* TestConsole.errorLines).toEqual([]);
      }),
    );

    it.effect("normalizes undefined data to null", () =>
      Effect.gen(function* () {
        yield* jsonSuccess(undefined);
        const lines = yield* TestConsole.logLines;
        expect(lines).toHaveLength(1);
        const output = JSON.parse(lines[0] as string);
        expect(output).toEqual({ ok: true, data: null });
        expect(yield* TestConsole.errorLines).toEqual([]);
      }),
    );
  });

  describe("jsonError", () => {
    it.effect("writes JSON envelope with ok:false to stderr", () =>
      Effect.gen(function* () {
        yield* jsonError("worktree_error", "Not found");
        const lines = yield* TestConsole.errorLines;
        expect(lines).toHaveLength(1);
        const output = JSON.parse(lines[0] as string);
        expect(output).toEqual({
          ok: false,
          error: { code: "worktree_error", message: "Not found" },
        });
        expect(yield* TestConsole.logLines).toEqual([]);
      }),
    );
  });
});

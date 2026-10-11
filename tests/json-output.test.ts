import { Console, Effect, Stdio } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonError, jsonSuccess } from "../src/utils/json-output";

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
  test("writes JSON envelope with ok:true to stdout", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await Effect.runPromise(jsonSuccess({ branch: "main", changes: 3 }));
      expect(spy).toHaveBeenCalledOnce();
      const output = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(output).toEqual({
        ok: true,
        data: { branch: "main", changes: 3 },
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("outputs valid JSON for arrays", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await Effect.runPromise(jsonSuccess([1, 2, 3]));
      const output = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(output).toEqual({ ok: true, data: [1, 2, 3] });
    } finally {
      spy.mockRestore();
    }
  });

  test("normalizes undefined data to null", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await Effect.runPromise(jsonSuccess(undefined));
      const output = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(output).toEqual({ ok: true, data: null });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("jsonError", () => {
  test("writes JSON envelope with ok:false to stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await Effect.runPromise(jsonError("worktree_error", "Not found"));
      expect(spy).toHaveBeenCalledOnce();
      const output = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(output).toEqual({
        ok: false,
        error: { code: "worktree_error", message: "Not found" },
      });
    } finally {
      spy.mockRestore();
    }
  });
});

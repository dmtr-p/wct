import { ConfigProvider, Console, Effect, Stdio } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JsonFlag } from "../src/cli/json-flag";
import * as logger from "../src/utils/logger";

beforeEach(() => {
  vi.stubEnv("FORCE_COLOR", undefined);
  vi.stubEnv("TERM", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function captureLogger(
  program: Effect.Effect<void, never, Stdio.Stdio>,
  terminals: Partial<
    Pick<Stdio.Stdio, "stdoutIsTerminal" | "stderrIsTerminal">
  >,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const capturedConsole: Console.Console = {
    ...console,
    log: (message) => stdout.push(String(message)),
    error: (message) => stderr.push(String(message)),
  };

  Effect.runSync(
    program.pipe(
      Effect.provideService(Console.Console, capturedConsole),
      Effect.provide(Stdio.layerTest(terminals)),
    ),
  );
  return { stdout, stderr };
}

const logMessages = Effect.gen(function* () {
  yield* logger.info("starting");
  yield* logger.success("finished");
  yield* logger.warn("optional step failed");
  yield* logger.step(1, 3, "install");
  yield* logger.error("setup failed");
  const styles = yield* logger.stdoutStyles;
  yield* Console.log(styles.bold("BRANCH"));
  yield* Console.log(styles.green("* session"));
});

describe("logger terminal styling", () => {
  test.each([undefined, "", "1"])(
    "JSON mode disables styling on terminal streams with NO_COLOR=%s",
    (noColor) => {
      vi.stubEnv("NO_COLOR", noColor);
      vi.stubEnv("FORCE_COLOR", "1");
      const output = captureLogger(
        Effect.provideService(logMessages, JsonFlag, true),
        {
          stdoutIsTerminal: Effect.succeed(true),
          stderrIsTerminal: Effect.succeed(true),
        },
      );
      expect([...output.stdout, ...output.stderr].join("\n")).not.toContain(
        "\x1b",
      );
      expect(output.stdout).toContain("BRANCH");
      expect(output.stdout).toContain("* session");
      expect(output.stderr).toEqual(["error setup failed"]);
    },
  );

  for (const stdoutTerminal of [false, true]) {
    for (const stderrTerminal of [false, true]) {
      test.each([
        {
          noColor: undefined,
          forceColor: undefined,
          term: undefined,
          color: "auto",
        },
        { noColor: "", forceColor: "", term: "xterm", color: "auto" },
        { noColor: undefined, forceColor: "0", term: undefined, color: "auto" },
        {
          noColor: undefined,
          forceColor: "false",
          term: undefined,
          color: "auto",
        },
        {
          noColor: undefined,
          forceColor: "FALSE",
          term: undefined,
          color: "auto",
        },
        { noColor: undefined, forceColor: "1", term: undefined, color: "on" },
        { noColor: undefined, forceColor: "3", term: undefined, color: "on" },
        { noColor: "1", forceColor: "1", term: undefined, color: "off" },
        {
          noColor: "false",
          forceColor: undefined,
          term: undefined,
          color: "off",
        },
        { noColor: undefined, forceColor: "1", term: "dumb", color: "off" },
      ])(
        `stdout terminal=${stdoutTerminal}, stderr terminal=${stderrTerminal}, environment=%j`,
        ({ noColor, forceColor, term, color }) => {
          vi.stubEnv("NO_COLOR", noColor);
          vi.stubEnv("FORCE_COLOR", forceColor);
          vi.stubEnv("TERM", term);
          const output = captureLogger(logMessages, {
            stdoutIsTerminal: Effect.succeed(stdoutTerminal),
            stderrIsTerminal: Effect.succeed(stderrTerminal),
          });
          const stdoutColor =
            color === "on" || (color === "auto" && stdoutTerminal);
          const stderrColor =
            color === "on" || (color === "auto" && stderrTerminal);

          expect(output.stdout).toEqual(
            stdoutColor
              ? [
                  "\x1b[34minfo\x1b[0m starting",
                  "\x1b[32mdone\x1b[0m finished",
                  "\x1b[33mwarn\x1b[0m optional step failed",
                  "\x1b[36m[1/3]\x1b[0m install",
                  "\x1b[1mBRANCH\x1b[0m",
                  "\x1b[32m* session\x1b[0m",
                ]
              : [
                  "info starting",
                  "done finished",
                  "warn optional step failed",
                  "[1/3] install",
                  "BRANCH",
                  "* session",
                ],
          );
          expect(output.stderr).toEqual([
            stderrColor
              ? "\x1b[31merror\x1b[0m setup failed"
              : "error setup failed",
          ]);
        },
      );
    }
  }

  test("defaults to plain output when terminal detection is not overridden", () => {
    vi.stubEnv("NO_COLOR", undefined);
    const output = captureLogger(logMessages, {});
    expect([...output.stdout, ...output.stderr].join("\n")).not.toContain(
      "\x1b",
    );
  });

  test("reads NO_COLOR when the logging Effect runs", () => {
    const terminals = { stdoutIsTerminal: Effect.succeed(true) };
    const program = logger.info("message");
    vi.stubEnv("NO_COLOR", undefined);
    expect(captureLogger(program, terminals).stdout).toEqual([
      "\x1b[34minfo\x1b[0m message",
    ]);
    vi.stubEnv("NO_COLOR", "1");
    expect(captureLogger(program, terminals).stdout).toEqual(["info message"]);
  });

  test("uses the caller's ConfigProvider instead of cached process capabilities", () => {
    vi.stubEnv("NO_COLOR", "1");
    const program = logger
      .info("message")
      .pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { FORCE_COLOR: "1" } }),
        ),
      );
    expect(captureLogger(program, {}).stdout).toEqual([
      "\x1b[34minfo\x1b[0m message",
    ]);
  });
});

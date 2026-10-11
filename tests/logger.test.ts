import { Console, Effect, Stdio } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JsonFlag } from "../src/cli/json-flag";
import * as logger from "../src/utils/logger";

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
      test.each([undefined, "", "1"])(
        `stdout terminal=${stdoutTerminal}, stderr terminal=${stderrTerminal}, NO_COLOR=%s`,
        (noColor) => {
          vi.stubEnv("NO_COLOR", noColor);
          const output = captureLogger(logMessages, {
            stdoutIsTerminal: Effect.succeed(stdoutTerminal),
            stderrIsTerminal: Effect.succeed(stderrTerminal),
          });
          const stdoutColor = stdoutTerminal && !noColor;
          const stderrColor = stderrTerminal && !noColor;

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
});

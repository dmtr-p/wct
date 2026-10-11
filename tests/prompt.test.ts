import { Effect, Option, Queue, Terminal } from "effect";
import { Prompt } from "effect/cli";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JsonFlag } from "../src/cli/json-flag";
import { runBunPromise } from "../src/effect/runtime";
import { confirm } from "../src/utils/prompt";

const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(
  process.stdout,
  "isTTY",
);

beforeEach(() => {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  vi.stubEnv("NO_COLOR", undefined);
});

afterEach(() => {
  if (stdoutTtyDescriptor) {
    Object.defineProperty(process.stdout, "isTTY", stdoutTtyDescriptor);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
  vi.unstubAllEnvs();
});

function runConfirmation(key: string, json = false) {
  return runBunPromise(
    Effect.gen(function* () {
      const input = yield* Queue.make<Terminal.UserInput>();
      yield* Queue.offer(input, {
        input: key === "enter" ? Option.none() : Option.some(key),
        key: { name: key, ctrl: false, meta: false, shift: false },
      });
      const output: string[] = [];
      let inputAcquisitions = 0;
      const terminal = Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        readLine: Effect.die("confirmation must use key input"),
        readInput: Effect.sync(() => {
          inputAcquisitions++;
          return input;
        }),
        display: (text) =>
          Effect.sync(() => {
            output.push(text);
          }),
      });

      const value = yield* confirm("Close worktree?").pipe(
        Effect.provideService(Terminal.Terminal, terminal),
        Effect.provideService(JsonFlag, json),
        // Create a fresh theme so each case uses its own NO_COLOR setting.
        Effect.provideService(Prompt.Theme, Prompt.makeTheme()),
      );
      return { value, output: output.join(""), inputAcquisitions };
    }),
  );
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: detect ANSI styling, excluding cursor/redraw controls
const STYLE_ESCAPE = /\x1b\[[0-9;]*m/;

describe("confirmation prompts", () => {
  test.each([undefined, "", "1"])(
    "terminal prompt respects NO_COLOR=%s and still accepts input",
    async (noColor) => {
      vi.stubEnv("NO_COLOR", noColor);
      const result = await runConfirmation("y");
      expect(result.value).toBe(true);
      expect(result.inputAcquisitions).toBe(1);
      expect(result.output).toContain("Close worktree?");
      expect(STYLE_ESCAPE.test(result.output)).toBe(!noColor);
      expect(result.output).toContain("\x1b[?25l");
    },
  );

  test.each(["enter", "n"])("%s declines confirmation", async (key) => {
    expect((await runConfirmation(key)).value).toBe(false);
  });

  test.each([undefined, "", "1"])(
    "JSON mode never displays a prompt or acquires input with NO_COLOR=%s",
    async (noColor) => {
      vi.stubEnv("NO_COLOR", noColor);
      // A queued 'y' must remain unread: JSON mode defaults to declining.
      const result = await runConfirmation("y", true);
      expect(result).toEqual({
        value: false,
        output: "",
        inputAcquisitions: 0,
      });
    },
  );
});

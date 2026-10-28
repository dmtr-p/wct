import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const entry = resolve("src/index.ts");
// eslint-disable-next-line no-control-regex -- distinguish styling from PTY cursor controls
const STYLE_ESCAPE = /\x1b\[[0-9;]*m/;

async function runInTerminal(
  command: string[],
  env: Record<string, string> = {},
) {
  let output = "";
  const closed = Promise.withResolvers<void>();
  const proc = Bun.spawn(command, {
    cwd: tmpdir(),
    env: {
      ...process.env,
      TERM: "xterm",
      FORCE_COLOR: "",
      NO_COLOR: "",
      ...env,
    },
    terminal: {
      cols: 200,
      data: (_terminal, data) => {
        output += new TextDecoder().decode(data);
      },
      exit: () => closed.resolve(),
    },
  });
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 4000);
  try {
    const exitCode = await proc.exited;
    await closed.promise;
    return { exitCode, output };
  } finally {
    clearTimeout(timeout);
    proc.kill("SIGKILL");
    proc.terminal?.close();
  }
}

describe("CLI terminal output", () => {
  test.each([
    { env: { FORCE_COLOR: "", NO_COLOR: "", TERM: "xterm" }, color: true },
    { env: { FORCE_COLOR: "0", NO_COLOR: "", TERM: "xterm" }, color: true },
    { env: { FORCE_COLOR: "false", NO_COLOR: "", TERM: "xterm" }, color: true },
    { env: { FORCE_COLOR: "1", NO_COLOR: "1", TERM: "xterm" }, color: false },
    { env: { FORCE_COLOR: "1", NO_COLOR: "", TERM: "dumb" }, color: false },
  ])(
    "styles help and errors on a real terminal with %j",
    async ({ env, color }) => {
      const result = await runInTerminal(
        [process.execPath, entry, "open", "feature", "--pr", "42"],
        env,
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("wct open");
      expect(result.output).toContain(
        "Cannot use --pr together with a branch argument",
      );
      expect(STYLE_ESCAPE.test(result.output)).toBe(color);
    },
  );

  test.each(["xterm", "dumb"])(
    "keeps JSON unstyled on a %s terminal despite FORCE_COLOR",
    async (term) => {
      const result = await runInTerminal(
        [process.execPath, entry, "open", "feature", "--pr", "42", "--json"],
        { FORCE_COLOR: "1", TERM: term },
      );
      expect(result.exitCode).toBe(1);
      expect(STYLE_ESCAPE.test(result.output)).toBe(false);
      expect(JSON.parse(result.output)).toEqual({
        ok: false,
        error: {
          code: "invalid_options",
          message: "Cannot use --pr together with a branch argument",
        },
      });
    },
  );

  test.each(["stdout", "stderr"] as const)(
    "detects each stream independently when %s is redirected",
    async (stream) => {
      const directory = await mkdtemp(join(tmpdir(), "wct-terminal-output-"));
      const destination = join(directory, "redirected");
      const script = `
      import { Effect } from ${JSON.stringify(Bun.resolveSync("effect", process.cwd()))};
      import { provideBunServices } from ${JSON.stringify(resolve("src/effect/runtime.ts"))};
      import { provideCliOutput } from ${JSON.stringify(resolve("src/cli/output.ts"))};
      import * as logger from ${JSON.stringify(resolve("src/utils/logger.ts"))};
      await Effect.runPromise(provideBunServices(provideCliOutput(
        Effect.gen(function* () {
          yield* logger.info("stdout message");
          yield* logger.error("stderr message");
        }),
        { suppressHelp: false },
      )));
    `;
      try {
        const result = await runInTerminal(
          [
            "bash",
            "-c",
            stream === "stdout"
              ? 'exec "$@" >"$WCT_TEST_OUTPUT"'
              : 'exec "$@" 2>"$WCT_TEST_OUTPUT"',
            "bash",
            process.execPath,
            "-e",
            script,
          ],
          { WCT_TEST_OUTPUT: destination },
        );
        const redirected = await Bun.file(destination).text();
        expect(result.exitCode).toBe(0);
        expect(STYLE_ESCAPE.test(result.output)).toBe(true);
        expect(result.output).toContain(
          `${stream === "stdout" ? "stderr" : "stdout"} message`,
        );
        expect(STYLE_ESCAPE.test(redirected)).toBe(false);
        expect(redirected).toBe(
          stream === "stdout"
            ? "info stdout message\n"
            : "error stderr message\n",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("CLI closed output pipes", () => {
  test.each(["stdout", "stderr"] as const)(
    "exits without a stack trace when the %s reader closes",
    async (stream) => {
      const args =
        stream === "stdout"
          ? ["open", "--help"]
          : ["open", "feature", "--pr", "42", "--json"];
      // Wait for EOF on stdin so the reader is closed before the CLI can write.
      const script = `
      await Bun.stdin.text();
      process.argv = [process.execPath, ${JSON.stringify(entry)}, ...${JSON.stringify(args)}];
      await import(${JSON.stringify(entry)});
    `;
      const proc = Bun.spawn([process.execPath, "-e", script], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: tmpdir(),
        env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: "", TERM: "xterm" },
      });
      const timeout = setTimeout(() => proc.kill("SIGKILL"), 4000);
      try {
        await proc[stream].cancel();
        const remaining = new Response(
          stream === "stdout" ? proc.stderr : proc.stdout,
        ).text();
        await proc.stdin.end();
        expect(await proc.exited).toBe(stream === "stdout" ? 0 : 1);
        expect(await remaining).toBe("");
      } finally {
        clearTimeout(timeout);
        proc.kill("SIGKILL");
      }
    },
  );
});

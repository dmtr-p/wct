import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Console, Effect } from "effect";
import { CliError, Command } from "effect/cli";
import { describe, expect, test, vi } from "vitest";
import { generateCompletionScript } from "../src/cli/completions";
import { rootCommand } from "../src/cli/root-command";
import { runBunPromise } from "../src/effect/runtime";
import { commandError } from "../src/errors";
import {
  liveWorkspaceService,
  type WorkspaceDownOptions,
  type WorkspaceOpenOptions,
  type WorkspaceUpOptions,
} from "../src/services/workspace-service";
import { withTestServices } from "./helpers/services";

const conflicts = [
  {
    args: ["up", "--path", "/checkout", "--branch", "feature"],
    message: "--path and --branch are mutually exclusive",
  },
  {
    args: ["down", "--path", "/checkout", "--branch", "feature"],
    message: "--path and --branch are mutually exclusive",
  },
  {
    args: ["open", "feature", "--pr", "42"],
    message: "Cannot use --pr together with a branch argument",
  },
  {
    args: ["open", "--pr", "42", "--base", "main"],
    message: "Cannot use --pr together with --base",
  },
  {
    args: ["open", "--pr", "42", "--existing"],
    message: "Cannot use --pr together with --existing",
  },
  {
    args: ["open", "feature", "--existing", "--base", "main"],
    message: "Options --existing and --base cannot be used together",
  },
] as const;

async function parseCommand(args: ReadonlyArray<string>) {
  const reachedHandler = commandError("worktree_error", "handler reached");
  const open = vi.fn((_options: WorkspaceOpenOptions) =>
    Effect.fail(reachedHandler),
  );
  const up = vi.fn((_options?: WorkspaceUpOptions) =>
    Effect.fail(reachedHandler),
  );
  const down = vi.fn((_options?: WorkspaceDownOptions) =>
    Effect.fail(reachedHandler),
  );
  const error = await runBunPromise(
    withTestServices(
      Command.runWith(rootCommand, { version: "test", renderErrors: false })([
        "--json",
        ...args,
      ]).pipe(
        Effect.flip,
        Effect.provideService(Console.Console, { ...console, log: () => {} }),
      ),
      { workspace: { ...liveWorkspaceService, open, up, down } },
    ),
  );
  return { error, reachedHandler, open, up, down };
}

function runCli(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, resolve("src/index.ts"), ...args], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      NO_COLOR: "",
      TERM: "xterm",
      ...env,
    },
  });
}

describe("CLI input validation", () => {
  test.each(conflicts)(
    "rejects $args before calling workspace handlers",
    async ({ args, message }) => {
      const result = await parseCommand(args);
      expect(result.error).toBeInstanceOf(CliError.ShowHelp);
      expect(result.error).toMatchObject({
        commandPath: ["wct", args[0]],
        errors: [{ _tag: "ValidationError", message }],
      });
      expect(result.open).not.toHaveBeenCalled();
      expect(result.up).not.toHaveBeenCalled();
      expect(result.down).not.toHaveBeenCalled();
    },
  );

  test.each([
    {
      args: ["open", "feature", "--pr", "bad", "--base", "main", "--existing"],
      message: conflicts[2].message,
    },
    {
      args: ["open", "--pr", "bad", "--base", "main", "--existing"],
      message: conflicts[3].message,
    },
    {
      args: ["open", "--existing", "--base", "main"],
      message: conflicts[5].message,
    },
  ])(
    "validates conflicts in order before PR, branch, or config resolution: $args",
    async ({ args, message }) => {
      const result = await parseCommand(args);
      expect(result.error).toMatchObject({ errors: [{ message }] });
      expect(result.open).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["up", "--path=", "--branch", "feature"],
    ["down", "--path", "/checkout", "--branch="],
    ["open", "feature", "--pr="],
    ["open", "--pr", "42", "--base="],
    ["open", "feature", "--existing", "--base="],
    ["open"],
  ])(
    "preserves empty optional values and service validation for %j",
    async (...args) => {
      const result = await parseCommand(args);
      expect(result.error).toBe(result.reachedHandler);
      expect(
        result.open.mock.calls.length +
          result.up.mock.calls.length +
          result.down.mock.calls.length,
      ).toBe(1);
    },
  );

  test.each(conflicts)(
    "emits one invalid_options JSON envelope for $args",
    ({ args, message }) => {
      for (const argv of [
        ["--json", ...args],
        [...args, "--json"],
      ]) {
        const result = runCli(argv);
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).toBe("");
        expect(JSON.parse(result.stderr.toString())).toEqual({
          ok: false,
          error: { code: "invalid_options", message },
        });
        expect(result.stderr.toString()).not.toContain("\x1b");
      }
    },
  );

  test.each([conflicts[0], conflicts[1], conflicts[2]])(
    "shows command help and the conflict in human mode: $args",
    ({ args, message }) => {
      const result = runCli([...args]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toContain(`wct ${args[0]}`);
      expect(result.stdout.toString()).toContain("--help");
      expect(result.stderr.toString()).toContain(message);
      expect(result.stderr.toString()).not.toContain("Help requested");
      expect(result.stderr.toString()).not.toContain("at ");
    },
  );
});

describe("built-in terminal styling", () => {
  test.each([
    { env: { FORCE_COLOR: "", NO_COLOR: "", TERM: "xterm" }, color: false },
    { env: { FORCE_COLOR: "1", NO_COLOR: "", TERM: "xterm" }, color: true },
    { env: { FORCE_COLOR: "0", NO_COLOR: "", TERM: "xterm" }, color: false },
    {
      env: { FORCE_COLOR: "false", NO_COLOR: "", TERM: "xterm" },
      color: false,
    },
    { env: { FORCE_COLOR: "1", NO_COLOR: "1", TERM: "xterm" }, color: false },
    { env: { FORCE_COLOR: "1", NO_COLOR: "", TERM: "dumb" }, color: false },
  ])(
    "colors help and validation errors consistently with %j",
    ({ env, color }) => {
      const result = runCli([...conflicts[2].args], env);
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toContain("wct open");
      expect(result.stdout.toString().includes("\x1b")).toBe(color);
      expect(result.stderr.toString().includes("\x1b")).toBe(color);
    },
  );
});

describe("boolean CLI spellings", () => {
  test.each(["open", "up"])("accepts --no-attach for %s", async (command) => {
    const result = await parseCommand([
      command,
      ...(command === "open" ? ["feature"] : []),
      "--no-attach",
    ]);
    expect(result.error).toBe(result.reachedHandler);
  });

  test.each([
    ["open", "feature", "--no-no-attach"],
    ["up", "--no-no-attach"],
    ["open", "feature", "--no-existing"],
    ["close", "feature", "--no-yes"],
    ["close", "feature", "--no-force"],
    ["list", "--no-short"],
    ["list", "--no-json"],
  ])("rejects undeclared inverses: %j", async (...args) => {
    const { error } = await parseCommand(args);
    expect(error).toMatchObject({
      _tag: "ShowHelp",
      errors: [expect.objectContaining({ _tag: "UnrecognizedOption" })],
    });
  });

  test.each(["bash", "zsh", "fish"] as const)(
    "%s completions offer only declared boolean spellings",
    (shell) => {
      const script = generateCompletionScript(shell);
      expect(script).toContain(
        shell === "fish" ? "-l no-attach" : "--no-attach",
      );
      for (const inverse of [
        "no-no-attach",
        "no-existing",
        "no-yes",
        "no-force",
        "no-short",
        "no-json",
      ]) {
        expect(script).not.toContain(inverse);
      }
    },
  );
});

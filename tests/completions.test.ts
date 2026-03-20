import { describe, expect, test } from "bun:test";

const { version: VERSION } = require("../package.json");

function runCliProcess(args: string[]) {
  return Bun.spawnSync(["bun", "run", "src/index.ts", ...args]);
}

describe("Effect CLI root", () => {
  test("renders built-in help from the root command", () => {
    const result = runCliProcess(["--help"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain("GLOBAL FLAGS");
    expect(output).toContain("--completions choice");
    expect(output).toContain("switch, sw");
    expect(output).not.toContain("\n  completions");
  });

  test("renders built-in version output", () => {
    const result = runCliProcess(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(`wct v${VERSION}`);
  });

  test("renders version output for the short -v flag", () => {
    const result = runCliProcess(["-v"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(`wct v${VERSION}`);
  });

  test("renders custom fish completions with branch and worktree helpers", () => {
    const result = runCliProcess(["--completions", "fish"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain("function __wct_branches");
    expect(output).toContain("function __wct_worktree_branches");
    expect(output).toContain("git branch --format='%(refname:short)'");
    expect(output).toContain("git worktree list --porcelain");
    expect(output).toContain("-a 'switch'");
    expect(output).not.toContain("-a 'completions'");
  });

  test("renders bash completions with command-specific options after a subcommand", () => {
    const result = runCliProcess(["--completions", "bash"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain(
      "COMPREPLY=($(compgen -W '--help --version --completions --log-level --base -b --existing -e --no-ide --no-attach --pr --prompt -p' -- \"$cur\"))",
    );
  });

  test("falls back to Effect built-in completions for sh", () => {
    const result = runCliProcess(["--completions", "sh"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain("Static completion script for Bash");
  });

  test("does not expose the legacy completions subcommand", async () => {
    const result = runCliProcess(["completions", "fish"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'Unknown subcommand "completions"',
    );
  });

  test("renders command validation failures without a stack trace", () => {
    const result = runCliProcess(["open"]);
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Missing branch name");
    expect(stderr).not.toContain("WctCommandError");
    expect(stderr).not.toContain("at ");
  });
});

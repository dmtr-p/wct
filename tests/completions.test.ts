import { describe, expect, test } from "vitest";
import packageJson from "../package.json";

const VERSION = packageJson.version;

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
    expect(output).toContain("projects");
    expect(output).toContain("switch, sw");
    expect(output).not.toContain("\n  register");
    expect(output).not.toContain("\n  unregister");
    expect(output).not.toContain("\n  completions");
  });

  test("renders built-in help for the short -h alias even when --json is present", () => {
    const result = runCliProcess(["--json", "-h"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(output).toContain("GLOBAL FLAGS");
    expect(output).toContain("--json");
    expect(output).toContain("switch, sw");
  });

  test("renders built-in help for bare --json invocations", () => {
    const result = runCliProcess(["--json"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(output).toContain("GLOBAL FLAGS");
    expect(output).toContain("--json");
    expect(output).toContain("switch, sw");
  });

  test("renders subcommand help for the short -h alias even when --json is present", () => {
    const result = runCliProcess(["open", "--json", "-h"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(output).toContain("USAGE");
    expect(output).toContain("wct open");
    expect(output).toContain("--base");
    expect(output).toContain("--json");
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
    expect(output).toContain("-a 'projects'");
    expect(output).toContain(
      "__fish_seen_subcommand_from projects; and not __fish_seen_subcommand_from add remove list",
    );
    expect(output).toContain("-a 'add' -d 'Add a project to the registry'");
    expect(output).toContain(
      "-a 'remove' -d 'Remove a project from the registry'",
    );
    expect(output).toContain("-a 'list' -d 'List registered projects'");
    expect(output).toContain(
      "__fish_seen_subcommand_from projects; and __fish_seen_subcommand_from add' -a '(__fish_complete_directories)' -d 'Path to repo'",
    );
    expect(output).toContain(
      "__fish_seen_subcommand_from projects; and __fish_seen_subcommand_from remove' -a '(__fish_complete_directories)' -d 'Path to repo'",
    );
    expect(output).toContain("-a 'switch'");
    expect(output).not.toContain("-a 'register'");
    expect(output).not.toContain("-a 'unregister'");
    expect(output).not.toContain("-a 'completions'");
  });

  test("renders bash completions with command-specific options after a subcommand", () => {
    const result = runCliProcess(["--completions", "bash"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain(
      "COMPREPLY=($(compgen -W '--help --version --completions --log-level --base -b --existing -e --no-ide --no-attach --pr --prompt -p --profile -P' -- \"$cur\"))",
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

  test("emits JSON for unknown subcommands when --json is present", () => {
    const result = runCliProcess(["--json", "nope"]);
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
    expect(() => JSON.parse(stderr)).not.toThrow();
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "unknown_command",
        }),
      }),
    );
    expect(parsed.error.message).toEqual(
      expect.stringContaining("Unknown subcommand"),
    );
    expect(parsed.error.message).toEqual(
      expect.stringContaining("Did you mean"),
    );
    expect(stderr).not.toContain("GLOBAL FLAGS");
    expect(stderr).not.toContain("Help requested");
  });

  test("emits JSON for the removed queue subcommand when --json is present", () => {
    const result = runCliProcess(["--json", "queue"]);
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
    expect(() => JSON.parse(stderr)).not.toThrow();
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "unknown_command",
        }),
      }),
    );
    expect(parsed.error.message).toEqual(
      expect.stringContaining("Unknown subcommand"),
    );
    expect(parsed.error.message).toEqual(expect.stringContaining("queue"));
    expect(stderr).not.toContain("GLOBAL FLAGS");
    expect(stderr).not.toContain("Help requested");
  });

  test("emits JSON for unrecognized flags when --json is present", () => {
    const result = runCliProcess(["--json", "open", "--bad-flag"]);
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
    expect(() => JSON.parse(stderr)).not.toThrow();
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "invalid_options",
        }),
      }),
    );
    expect(parsed.error.message).toEqual(
      expect.stringContaining("Unrecognized flag"),
    );
    expect(parsed.error.message).toEqual(expect.stringContaining("--bad-flag"));
    expect(stderr).not.toContain("GLOBAL FLAGS");
    expect(stderr).not.toContain("Help requested");
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

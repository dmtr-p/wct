import { describe, expect, spyOn, test } from "bun:test";
import { completionsCommand } from "../src/commands/completions";

function captureFishCompletions(): string {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});

  try {
    const result = completionsCommand("fish");
    expect(result.success).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
    return String(logSpy.mock.calls[0]?.[0] ?? "");
  } finally {
    logSpy.mockRestore();
  }
}

describe("fish completions", () => {
  test("escapes apostrophes in command descriptions", () => {
    const output = captureFishCompletions();

    expect(output).toContain(
      "complete -c wct -n '__fish_use_subcommand' -a 'switch' -d 'Switch to another worktree\\'s tmux session'",
    );
  });

  test("uses regex filtering for worktree branch helper", () => {
    const output = captureFishCompletions();

    expect(output).toContain(
      "git worktree list --porcelain 2>/dev/null | string match -rg '^branch refs/heads/(.+)$'",
    );
    expect(output).not.toContain("string replace -rf");
  });

  test("includes sw alias in worktree branch completion condition", () => {
    const output = captureFishCompletions();

    expect(output).toContain(
      "complete -c wct -n '__fish_seen_subcommand_from cd close switch sw' -a '(__wct_worktree_branches)' -d 'Branch name'",
    );
  });
});

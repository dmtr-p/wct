import { basename } from "node:path";
import { $ } from "bun";
import { formatSessionName, sessionExists } from "../services/tmux";
import { getMainWorktreePath, listWorktrees } from "../services/worktree";
import * as logger from "../utils/logger";
import { type CommandResult, ok } from "../utils/result";
import type { CommandDef } from "./registry";

export const commandDef: CommandDef = {
  name: "status",
  description: "Show worktree dashboard with changes and sync status",
};

interface StatusRow {
  branch: string;
  tmux: string;
  changes: string;
  behind: string;
}

export async function getChangedFilesCount(
  worktreePath: string,
): Promise<number> {
  try {
    const result = await $`git status --porcelain`.quiet().cwd(worktreePath);
    const output = result.text().trim();
    if (!output) return 0;
    return output.split("\n").length;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`Failed to get changes for ${worktreePath}: ${message}`);
    return 0;
  }
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const result = await $`git symbolic-ref refs/remotes/origin/HEAD`
      .quiet()
      .cwd(repoPath);
    const ref = result.text().trim();
    // refs/remotes/origin/main -> main
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // Fallback: check if common default branch names exist
    for (const candidate of ["main", "master"]) {
      try {
        await $`git rev-parse --verify ${candidate}`.quiet().cwd(repoPath);
        return candidate;
      } catch {}
    }
    return "main";
  }
}

export async function getCommitsBehind(
  worktreePath: string,
  defaultBranch: string,
): Promise<number> {
  try {
    const result = await $`git rev-list HEAD..${defaultBranch} --count`
      .quiet()
      .cwd(worktreePath);
    return Number.parseInt(result.text().trim(), 10);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(
      `Failed to get commits behind '${defaultBranch}' for ${worktreePath}: ${message}`,
    );
    return 0;
  }
}

function formatChanges(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function formatBehind(count: number): string {
  return `\u2193${count}`;
}

export async function statusCommand(): Promise<CommandResult> {
  const worktrees = await listWorktrees();

  // Exclude the main repo directory (first worktree)
  const nonMainWorktrees = worktrees.filter((wt, i) => i > 0 && !wt.isBare);

  if (nonMainWorktrees.length === 0) {
    logger.info("No worktrees found");
    return ok();
  }

  // Detect default branch from the main repo
  const mainRepoPath = await getMainWorktreePath();
  const defaultBranch = mainRepoPath
    ? await getDefaultBranch(mainRepoPath)
    : "main";

  const rows: StatusRow[] = await Promise.all(
    nonMainWorktrees.map(async (wt) => {
      const branch = wt.branch || "(unknown)";
      const sessionName = formatSessionName(basename(wt.path));
      const isAlive = await sessionExists(sessionName);
      const changesCount = await getChangedFilesCount(wt.path);
      const behindCount = await getCommitsBehind(wt.path, defaultBranch);

      return {
        branch,
        tmux: isAlive ? "alive" : "dead",
        changes: formatChanges(changesCount),
        behind: formatBehind(behindCount),
      };
    }),
  );

  const headers = ["BRANCH", "TMUX", "CHANGES", "BEHIND"] as const;
  const colWidths = [
    Math.max(headers[0].length, ...rows.map((r) => r.branch.length)),
    Math.max(headers[1].length, ...rows.map((r) => r.tmux.length)),
    Math.max(headers[2].length, ...rows.map((r) => r.changes.length)),
    Math.max(headers[3].length, ...rows.map((r) => r.behind.length)),
  ] as const;

  const green = Bun.color("green", "ansi") ?? "";
  const red = Bun.color("red", "ansi") ?? "";
  const reset = "\x1b[0m";

  const headerLine = headers
    .map((h, i) => h.padEnd(colWidths[i] as number))
    .join("  ");
  console.log(logger.bold(headerLine));

  for (const row of rows) {
    const tmuxColored =
      row.tmux === "alive"
        ? `${green}${row.tmux}${reset}`
        : `${red}${row.tmux}${reset}`;
    // Pad after the raw text (before ANSI codes would affect width)
    const tmuxPadded =
      tmuxColored + " ".repeat(Math.max(0, colWidths[1] - row.tmux.length));

    const line = [
      row.branch.padEnd(colWidths[0]),
      tmuxPadded,
      row.changes.padEnd(colWidths[2]),
      row.behind.padEnd(colWidths[3]),
    ].join("  ");
    console.log(line);
  }

  return ok();
}

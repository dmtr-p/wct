import { basename, relative } from "node:path";
import { $ } from "bun";
import { formatSessionName, listSessions } from "../services/tmux";
import { getMainWorktreePath, listWorktrees } from "../services/worktree";
import * as logger from "../utils/logger";
import { type CommandResult, ok } from "../utils/result";
import type { CommandDef } from "./registry";

export const commandDef: CommandDef = {
  name: "list",
  description: "Show worktrees with tmux, changes, and sync status",
  options: [
    {
      name: "short",
      short: "s",
      type: "boolean",
      description: "Print branch names only",
    },
  ],
};

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

export async function getAheadBehind(
  worktreePath: string,
  defaultBranch: string,
): Promise<{ ahead: number; behind: number }> {
  try {
    const result =
      await $`git rev-list --left-right --count HEAD...${defaultBranch}`
        .quiet()
        .cwd(worktreePath);
    const [ahead, behind] = result
      .text()
      .trim()
      .split(/\s+/)
      .map((n) => {
        const parsed = Number.parseInt(n, 10);
        return Number.isNaN(parsed) ? 0 : parsed;
      });
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`Failed to get sync status for ${worktreePath}: ${message}`);
    return { ahead: 0, behind: 0 };
  }
}

export function formatChanges(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

export function formatSync(ahead: number, behind: number): string {
  if (ahead === 0 && behind === 0) return "\u2713";
  const parts: string[] = [];
  if (ahead > 0) parts.push(`\u2191${ahead}`);
  if (behind > 0) parts.push(`\u2193${behind}`);
  return parts.join(" ");
}

interface ListRow {
  branch: string;
  path: string;
  tmux: string;
  tmuxRaw: string;
  changes: string;
  sync: string;
}

export async function listCommand(opts?: {
  short?: boolean;
}): Promise<CommandResult> {
  const worktrees = await listWorktrees();

  const nonBareWorktrees = worktrees.filter((wt) => !wt.isBare);

  if (nonBareWorktrees.length === 0) {
    logger.info("No worktrees found");
    return ok();
  }

  if (opts?.short) {
    for (const wt of nonBareWorktrees) {
      console.log(wt.branch || "(unknown)");
    }
    return ok();
  }

  const sessions = (await listSessions()) ?? [];
  const mainRepoPath = await getMainWorktreePath();
  const defaultBranch = mainRepoPath
    ? await getDefaultBranch(mainRepoPath)
    : "main";

  const green = Bun.color("green", "ansi") ?? "";
  const reset = "\x1b[0m";
  const cwd = process.cwd();

  const rows: ListRow[] = await Promise.all(
    nonBareWorktrees.map(async (wt) => {
      const branch = wt.branch || "(unknown)";
      const sessionName = formatSessionName(basename(wt.path));
      const session = sessions.find((s) => s.name === sessionName);
      const changesCount = await getChangedFilesCount(wt.path);
      const { ahead, behind } = await getAheadBehind(wt.path, defaultBranch);

      let tmux = "";
      let tmuxRaw = "";
      if (session) {
        if (session.attached) {
          tmuxRaw = `* ${sessionName}`;
          tmux = `${green}${tmuxRaw}${reset}`;
        } else {
          tmuxRaw = `  ${sessionName}`;
          tmux = tmuxRaw;
        }
      }

      return {
        branch,
        path: relative(cwd, wt.path) || ".",
        tmux,
        tmuxRaw,
        changes: formatChanges(changesCount),
        sync: formatSync(ahead, behind),
      };
    }),
  );

  const headers = ["BRANCH", "PATH", "TMUX", "CHANGES", "SYNC"] as const;
  const colWidths = [
    Math.max(headers[0].length, ...rows.map((r) => r.branch.length)),
    Math.max(headers[1].length, ...rows.map((r) => r.path.length)),
    Math.max(headers[2].length, ...rows.map((r) => r.tmuxRaw.length)),
    Math.max(headers[3].length, ...rows.map((r) => r.changes.length)),
    Math.max(headers[4].length, ...rows.map((r) => r.sync.length)),
  ] as const;

  const headerLine = headers
    .map((h, i) => h.padEnd(colWidths[i] as number))
    .join("  ");
  console.log(logger.bold(headerLine));

  for (const row of rows) {
    // Pad tmux using raw (non-ANSI) length
    const tmuxPadded =
      row.tmux + " ".repeat(Math.max(0, colWidths[2] - row.tmuxRaw.length));

    const line = [
      row.branch.padEnd(colWidths[0]),
      row.path.padEnd(colWidths[1]),
      tmuxPadded,
      row.changes.padEnd(colWidths[3]),
      row.sync.padEnd(colWidths[4]),
    ].join("  ");
    console.log(line);
  }

  return ok();
}

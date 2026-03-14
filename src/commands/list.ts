import { basename, relative } from "node:path";
import { Console, Effect } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { execProcess } from "../services/process";
import { formatSessionName, TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

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

export function getChangedFilesCount(worktreePath: string) {
  return Effect.catch(
    execProcess("git", ["status", "--porcelain"], {
      cwd: worktreePath,
    }).pipe(
      Effect.map((result) => {
        const output = result.stdout.trim();
        if (!output) return 0;
        return output.split("\n").length;
      }),
    ),
    (error) =>
      logger
        .warn(
          `Failed to get changes for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .pipe(Effect.as(0)),
  );
}

export function getDefaultBranch(repoPath: string) {
  return Effect.gen(function* () {
    const ref = yield* Effect.catch(
      execProcess("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
        cwd: repoPath,
      }).pipe(Effect.map((result) => result.stdout.trim())),
      () => Effect.succeed(null),
    );
    if (ref) {
      return ref.replace("refs/remotes/origin/", "");
    }

    for (const candidate of ["main", "master"]) {
      const exists = yield* Effect.catch(
        execProcess("git", ["rev-parse", "--verify", candidate], {
          cwd: repoPath,
        }).pipe(Effect.as(true)),
        () => Effect.succeed(false),
      );
      if (exists) {
        return candidate;
      }
    }
    return null;
  });
}

export function getAheadBehind(
  worktreePath: string,
  defaultBranch: string | null,
) {
  if (!defaultBranch) {
    return Effect.succeed(null);
  }

  return Effect.catch(
    execProcess(
      "git",
      ["rev-list", "--left-right", "--count", `HEAD...${defaultBranch}`],
      { cwd: worktreePath },
    ).pipe(
      Effect.map((result) => {
        const [ahead, behind] = result.stdout
          .trim()
          .split(/\s+/)
          .map((n: string) => {
            const parsed = Number.parseInt(n, 10);
            return Number.isNaN(parsed) ? 0 : parsed;
          });
        return { ahead: ahead ?? 0, behind: behind ?? 0 };
      }),
    ),
    (error) =>
      logger
        .warn(
          `Failed to get sync status for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .pipe(Effect.as(null)),
  );
}

export function formatChanges(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

export function formatSync(
  sync: { ahead: number; behind: number } | null,
): string {
  if (!sync) return "?";
  const { ahead, behind } = sync;
  if (ahead === 0 && behind === 0) return "\u2713";
  const parts: string[] = [];
  if (ahead > 0) parts.push(`\u2191${ahead}`);
  if (behind > 0) parts.push(`\u2193${behind}`);
  return parts.join(" ");
}

export function listCommand(opts?: {
  short?: boolean;
}): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const worktrees = yield* WorktreeService.use((service) =>
      service.listWorktrees(),
    );
    const nonBareWorktrees = worktrees.filter((wt) => !wt.isBare);

    if (nonBareWorktrees.length === 0) {
      yield* logger.info("No worktrees found");
      return;
    }

    if (opts?.short) {
      for (const wt of nonBareWorktrees) {
        yield* Console.log(wt.branch || "(unknown)");
      }
      return;
    }

    const [sessionsList, mainRepoPath] = yield* Effect.all([
      TmuxService.use((service) => service.listSessions()),
      WorktreeService.use((service) => service.getMainWorktreePath()),
    ]);
    const sessions = sessionsList ?? [];
    const defaultBranch = mainRepoPath
      ? yield* Effect.mapError(getDefaultBranch(mainRepoPath), (error) =>
          commandError(
            "worktree_error",
            "Failed to determine the default branch",
            error,
          ),
        )
      : null;

    const cwd = process.cwd();
    const rows = yield* Effect.mapError(
      Effect.forEach(nonBareWorktrees, (wt) =>
        Effect.gen(function* () {
          const branch = wt.branch || "(unknown)";
          const sessionName = formatSessionName(basename(wt.path));
          const session = sessions.find((s) => s.name === sessionName);
          const [changesCount, syncStatus] = yield* Effect.all([
            getChangedFilesCount(wt.path),
            getAheadBehind(wt.path, defaultBranch),
          ]);

          let tmux = "";
          let tmuxRaw = "";
          if (session) {
            if (session.attached) {
              tmuxRaw = `* ${sessionName}`;
              tmux = logger.green(tmuxRaw);
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
            sync: formatSync(syncStatus),
          };
        }),
      ),
      (error) =>
        commandError(
          "worktree_error",
          "Failed to collect worktree status",
          error,
        ),
    );

    const headers = ["BRANCH", "PATH", "TMUX", "CHANGES", "SYNC"] as const;
    const colWidths = [
      Math.max(headers[0].length, ...rows.map((row) => row.branch.length)),
      Math.max(headers[1].length, ...rows.map((row) => row.path.length)),
      Math.max(headers[2].length, ...rows.map((row) => row.tmuxRaw.length)),
      Math.max(headers[3].length, ...rows.map((row) => row.changes.length)),
      Math.max(headers[4].length, ...rows.map((row) => row.sync.length)),
    ] as const;

    const headerLine = headers
      .map((header, index) => header.padEnd(colWidths[index] as number))
      .join("  ");
    yield* Console.log(logger.bold(headerLine));

    for (const row of rows) {
      const tmuxPadded =
        row.tmux + " ".repeat(Math.max(0, colWidths[2] - row.tmuxRaw.length));

      const line = [
        row.branch.padEnd(colWidths[0]),
        row.path.padEnd(colWidths[1]),
        tmuxPadded,
        row.changes.padEnd(colWidths[3]),
        row.sync.padEnd(colWidths[4]),
      ].join("  ");
      yield* Console.log(line);
    }
  });
}

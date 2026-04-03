import { basename, relative } from "node:path";
import { Console, Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { formatSessionName, TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import {
  formatChanges,
  formatSync,
  getAheadBehind,
  getChangedFilesCount,
  getDefaultBranch,
} from "../services/worktree-status";
import { jsonSuccess } from "../utils/json-output";
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

export function listCommand(opts?: {
  short?: boolean;
}): Effect.Effect<
  void,
  WctError,
  WctServices | "effect/unstable/cli/GlobalFlag/json"
> {
  return Effect.gen(function* () {
    const json = yield* JsonFlag;
    const worktrees = yield* WorktreeService.use((service) =>
      service.listWorktrees(),
    );
    const nonBareWorktrees = worktrees.filter((wt) => !wt.isBare);

    if (nonBareWorktrees.length === 0) {
      if (json) {
        yield* jsonSuccess([]);
        return;
      }
      yield* logger.info("No worktrees found");
      return;
    }

    if (!json && opts?.short) {
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
            tmuxJson: session
              ? { session: session.name, attached: session.attached }
              : null,
            changesCount,
            changes: formatChanges(changesCount),
            syncStatus,
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

    if (json) {
      yield* jsonSuccess(
        rows.map((row) => ({
          branch: row.branch,
          path: row.path,
          tmux: row.tmuxJson,
          changes: row.changesCount,
          sync: row.syncStatus,
        })),
      );
      return;
    }

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

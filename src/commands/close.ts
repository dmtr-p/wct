import { basename } from "node:path";
import { Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { formatSessionName, TmuxService } from "../services/tmux";
import {
  type WorkspaceCloseResult,
  WorkspaceService,
} from "../services/workspace-service";
import { WorktreeService } from "../services/worktree-service";
import { jsonSuccess } from "../utils/json-output";
import * as logger from "../utils/logger";
import { confirm } from "../utils/prompt";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "close",
  description: "Kill tmux session and remove worktree",
  args: "<branch...>",
  completionType: "worktree",
  options: [
    {
      name: "yes",
      short: "y",
      type: "boolean",
      description: "Skip confirmation prompt",
    },
    {
      name: "force",
      short: "f",
      type: "boolean",
      description: "Force removal even if worktree is dirty",
    },
  ],
};

export interface CloseOptions {
  branches: string[];
  yes?: boolean;
  force?: boolean;
}

export function closeCommand(
  options: CloseOptions,
): Effect.Effect<
  void,
  WctError,
  WctServices | "effect/unstable/cli/GlobalFlag/json"
> {
  return Effect.gen(function* () {
    const { branches, yes = false, force = false } = options;
    const branchQueue = [...branches];
    let deferredCurrentSessionBranch = false;
    const results: WorkspaceCloseResult[] = [];
    const json = yield* JsonFlag;

    const repo = yield* WorktreeService.use((service) => service.isGitRepo());
    if (!repo) {
      return yield* Effect.fail(
        commandError("not_git_repo", "Not a git repository"),
      );
    }

    const currentSession = yield* TmuxService.use((service) =>
      service.getCurrentSession(),
    );
    let processedCount = 0;

    while (branchQueue.length > 0) {
      const branch = branchQueue.shift();
      if (!branch) {
        break;
      }

      const worktree = yield* WorktreeService.use((service) =>
        service.findWorktreeByBranch(branch),
      );
      if (!worktree) {
        return yield* Effect.fail(
          commandError(
            "worktree_not_found",
            `No worktree found for branch '${branch}'`,
          ),
        );
      }

      const worktreePath = worktree.path;
      const sessionName = formatSessionName(basename(worktreePath));

      if (
        currentSession &&
        sessionName === currentSession &&
        branchQueue.length > 0 &&
        !deferredCurrentSessionBranch
      ) {
        if (!json) {
          yield* logger.warn(
            `Deferring branch '${branch}' because it is the current tmux session`,
          );
        }
        branchQueue.push(branch);
        deferredCurrentSessionBranch = true;
        continue;
      }

      if (!json && branches.length > 1) {
        yield* logger.info(
          `Closing branch '${branch}' (${processedCount + 1}/${branches.length})`,
        );
      }

      if (!yes) {
        const confirmed = yield* Effect.mapError(
          confirm(
            `Close worktree '${branch}' and kill tmux session '${sessionName}'?`,
          ),
          (error) =>
            commandError("tmux_error", "Confirmation prompt failed", error),
        );
        if (!confirmed) {
          if (!json) {
            yield* logger.info("Aborted");
          }
          return;
        }
      }

      if (currentSession === sessionName && !yes) {
        const confirmed = yield* Effect.mapError(
          confirm(
            "You are inside this tmux session. It will be killed. Continue?",
          ),
          (error) =>
            commandError("tmux_error", "Confirmation prompt failed", error),
        );
        if (!confirmed) {
          if (!json) {
            yield* logger.info("Aborted");
          }
          return;
        }
      }

      let result = yield* WorkspaceService.use((service) =>
        service.close({ branch, force }),
      );
      const killedSession = result.existed;

      if (result.status === "blocked_by_changes") {
        if (!force) {
          if (!yes) {
            const forceConfirmed = yield* Effect.mapError(
              confirm("Worktree has uncommitted changes. Force remove anyway?"),
              (error) =>
                commandError("tmux_error", "Confirmation prompt failed", error),
            );
            if (!forceConfirmed) {
              if (!json) {
                yield* logger.info("Aborted");
              }
              return;
            }
          }
          result = yield* WorkspaceService.use((service) =>
            service.close({ branch, force: true }),
          );
        }

        if (result.status === "blocked_by_changes") {
          return yield* Effect.fail(
            commandError(
              "worktree_remove_failed",
              "Failed to force remove worktree with uncommitted changes.",
            ),
          );
        }
      }

      if (!json) {
        if (killedSession) {
          yield* logger.success(`Killed tmux session '${result.sessionName}'`);
        } else {
          yield* logger.info(`No tmux session '${result.sessionName}' found`);
        }
      }
      if (!json) {
        yield* logger.success(`Removed worktree '${branch}'`);
      }
      results.push(result);
      processedCount += 1;
    }

    if (json) {
      yield* jsonSuccess(results);
    }
  });
}

import { basename } from "node:path";
import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, toWctError, type WctError } from "../errors";
import { QueueStorage } from "../services/queue-storage";
import { formatSessionName, TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
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
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const { branches, yes = false, force = false } = options;
    const branchQueue = [...branches];
    let deferredCurrentSessionBranch = false;

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
        yield* logger.warn(
          `Deferring branch '${branch}' because it is the current tmux session`,
        );
        branchQueue.push(branch);
        deferredCurrentSessionBranch = true;
        continue;
      }

      if (branches.length > 1) {
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
          yield* logger.info("Aborted");
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
          yield* logger.info("Aborted");
          return;
        }
      }

      const exists = yield* TmuxService.use((service) =>
        service.sessionExists(sessionName),
      );
      if (exists) {
        yield* logger.info(`Killing tmux session '${sessionName}'...`);
        const killed = yield* Effect.catch(
          TmuxService.use((service) => service.killSession(sessionName)).pipe(
            Effect.as(true),
          ),
          (error) =>
            logger
              .warn(`Failed to kill tmux session: ${toWctError(error).message}`)
              .pipe(Effect.as(false)),
        );
        if (killed) {
          yield* logger.success(`Killed tmux session '${sessionName}'`);
          yield* Effect.catch(
            QueueStorage.use((service) =>
              service.removeItemsBySession(sessionName),
            ),
            (error) =>
              logger.warn(
                `Failed to clean queue entries for session '${sessionName}': ${toWctError(error).message}`,
              ),
          );
        }
      } else {
        yield* logger.warn(`Tmux session '${sessionName}' does not exist`);
      }

      yield* logger.info(`Removing worktree at ${worktreePath}...`);
      const removeResult = yield* WorktreeService.use((service) =>
        service.removeWorktree(worktreePath, force),
      );

      if (removeResult._tag === "Removed") {
        yield* logger.success(`Removed worktree '${branch}'`);
        processedCount += 1;
      } else if (removeResult._tag === "BlockedByChanges") {
        if (!yes) {
          const forceConfirmed = yield* Effect.mapError(
            confirm("Worktree has uncommitted changes. Force remove anyway?"),
            (error) =>
              commandError("tmux_error", "Confirmation prompt failed", error),
          );
          if (!forceConfirmed) {
            yield* logger.info("Aborted");
            return;
          }
        }
        const retryResult = yield* WorktreeService.use((service) =>
          service.removeWorktree(worktreePath, true),
        );
        if (retryResult._tag === "Removed") {
          yield* logger.success(`Removed worktree '${branch}'`);
          processedCount += 1;
        } else {
          return yield* Effect.fail(
            commandError(
              "worktree_remove_failed",
              "Failed to force remove worktree with uncommitted changes.",
            ),
          );
        }
      }
    }
  });
}

import { basename } from "node:path";
import { removeItemsBySession } from "../services/queue";
import {
  formatSessionName,
  getCurrentSession,
  killSession,
  sessionExists,
} from "../services/tmux";
import {
  findWorktreeByBranch,
  isGitRepo,
  removeWorktree,
} from "../services/worktree";
import * as logger from "../utils/logger";
import { confirm } from "../utils/prompt";
import { type CommandResult, err, ok } from "../utils/result";
import type { CommandDef } from "./registry";

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

export async function closeCommand(
  options: CloseOptions,
): Promise<CommandResult> {
  const { branches, yes = false, force = false } = options;
  const branchQueue = [...branches];
  let deferredCurrentSessionBranch = false;

  if (!(await isGitRepo())) {
    return err("Not a git repository", "not_git_repo");
  }

  const currentSession = await getCurrentSession();
  let processedCount = 0;

  while (branchQueue.length > 0) {
    const branch = branchQueue.shift();
    if (!branch) {
      break;
    }

    const worktree = await findWorktreeByBranch(branch);
    if (!worktree) {
      return err(
        `No worktree found for branch '${branch}'`,
        "worktree_not_found",
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
      logger.warn(
        `Deferring branch '${branch}' because it is the current tmux session`,
      );
      branchQueue.push(branch);
      deferredCurrentSessionBranch = true;
      continue;
    }

    if (branches.length > 1) {
      logger.info(
        `Closing branch '${branch}' (${processedCount + 1}/${branches.length})`,
      );
    }

    if (!yes) {
      const confirmed = await confirm(
        `Close worktree '${branch}' and kill tmux session '${sessionName}'?`,
      );
      if (!confirmed) {
        logger.info("Aborted");
        return ok();
      }
    }

    if (currentSession === sessionName && !yes) {
      const confirmed = await confirm(
        "You are inside this tmux session. It will be killed. Continue?",
      );
      if (!confirmed) {
        logger.info("Aborted");
        return ok();
      }
    }

    if (await sessionExists(sessionName)) {
      logger.info(`Killing tmux session '${sessionName}'...`);
      const killResult = await killSession(sessionName);
      if (killResult.success) {
        removeItemsBySession(sessionName);
        logger.success(`Killed tmux session '${sessionName}'`);
      } else {
        logger.warn(`Failed to kill tmux session: ${killResult.error}`);
      }
    } else {
      logger.warn(`Tmux session '${sessionName}' does not exist`);
    }

    logger.info(`Removing worktree at ${worktreePath}...`);
    const removeResult = await removeWorktree(worktreePath, force);

    if (removeResult.success) {
      logger.success(`Removed worktree '${branch}'`);
      processedCount += 1;
    } else {
      if (removeResult.code === "worktree_has_uncommitted_changes") {
        return err(
          "Worktree has uncommitted changes. Use --force to remove anyway.",
          "worktree_remove_failed",
        );
      } else {
        return err(
          `Failed to remove worktree: ${removeResult.error}`,
          "worktree_remove_failed",
        );
      }
    }
  }

  return ok();
}

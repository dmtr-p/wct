import { basename } from "node:path";
import {
  attachSession,
  formatSessionName,
  sessionExists,
  switchSession,
} from "../services/tmux";
import { findWorktreeByBranch, isGitRepo } from "../services/worktree";
import * as logger from "../utils/logger";
import { type CommandResult, err, ok } from "../utils/result";
import type { CommandDef } from "./registry";

export const commandDef: CommandDef = {
  name: "switch",
  aliases: ["sw"],
  description: "Switch to another worktree's tmux session",
  args: "<branch>",
  completionType: "worktree",
};

export async function switchCommand(branch: string): Promise<CommandResult> {
  if (!(await isGitRepo())) {
    return err("Not a git repository", "not_git_repo");
  }

  const worktree = await findWorktreeByBranch(branch);
  if (!worktree) {
    return err(
      `No worktree found for branch '${branch}'. Try: wct open ${branch}`,
      "worktree_not_found",
    );
  }

  const sessionName = formatSessionName(basename(worktree.path));

  if (!(await sessionExists(sessionName))) {
    return err(
      `No tmux session '${sessionName}' for branch '${branch}'. Try: wct up (from the worktree directory)`,
      "tmux_error",
    );
  }

  const insideTmux = !!process.env.TMUX;

  if (insideTmux) {
    const result = await switchSession(sessionName);
    if (!result.success) {
      return err(
        `Failed to switch to session '${sessionName}': ${result.error}`,
        "tmux_error",
      );
    }
    logger.success(`Switched to session '${sessionName}'`);
  } else {
    logger.info(`Attaching to session '${sessionName}'...`);
    const result = await attachSession(sessionName);
    if (!result.success) {
      return err(
        `Failed to attach to session '${sessionName}': ${result.error}`,
        "tmux_error",
      );
    }
  }

  return ok();
}

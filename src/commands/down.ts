import { basename } from "node:path";
import {
  formatSessionName,
  killSession,
  sessionExists,
} from "../services/tmux";
import { isGitRepo } from "../services/worktree";
import * as logger from "../utils/logger";
import { type CommandResult, err, ok } from "../utils/result";

export async function downCommand(): Promise<CommandResult> {
  if (!(await isGitRepo())) {
    return err("Not a git repository", "not_git_repo");
  }

  const cwd = process.cwd();
  const sessionName = formatSessionName(basename(cwd));

  if (!(await sessionExists(sessionName))) {
    logger.warn(`No tmux session '${sessionName}' found`);
    return ok();
  }

  logger.info(`Killing tmux session '${sessionName}'...`);
  const result = await killSession(sessionName);

  if (result.success) {
    logger.success(`Killed tmux session '${sessionName}'`);
    return ok();
  } else {
    return err(`Failed to kill tmux session: ${result.error}`, "tmux_error");
  }
}

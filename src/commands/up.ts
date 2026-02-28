import { basename } from "node:path";
import { loadConfig } from "../config/loader";
import { openIDE } from "../services/ide";
import {
  createSession,
  formatSessionName,
  switchSession,
} from "../services/tmux";
import {
  getCurrentBranch,
  getMainRepoPath,
  isGitRepo,
} from "../services/worktree";
import type { WctEnv } from "../types/env";
import * as logger from "../utils/logger";
import { type CommandResult, err, ok } from "../utils/result";
import type { CommandDef } from "./registry";

export const commandDef: CommandDef = {
  name: "up",
  description: "Start tmux session and open IDE in current directory",
  options: [
    {
      name: "no-ide",
      type: "boolean",
      description: "Skip opening IDE",
    },
  ],
};

export interface UpOptions {
  noIde?: boolean;
}

export async function upCommand(options?: UpOptions): Promise<CommandResult> {
  const { noIde } = options ?? {};
  if (!(await isGitRepo())) {
    return err("Not a git repository", "not_git_repo");
  }

  const cwd = process.cwd();

  const mainRepoPath = await getMainRepoPath();
  if (!mainRepoPath) {
    return err("Could not determine repository root", "worktree_error");
  }

  const { config, errors } = await loadConfig(mainRepoPath);
  if (!config) {
    return err(errors.join("\n"), "config_error");
  }

  const branch = await getCurrentBranch();
  if (!branch) {
    return err(
      "Could not determine current branch (detached HEAD is not supported)",
      "detached_head",
    );
  }

  const sessionName = formatSessionName(basename(cwd));

  const env: WctEnv = {
    WCT_WORKTREE_DIR: cwd,
    WCT_MAIN_DIR: mainRepoPath,
    WCT_BRANCH: branch,
    WCT_PROJECT: config.project_name,
  };

  if (config.tmux) {
    logger.info("Creating tmux session...");
    const tmuxResult = await createSession(sessionName, cwd, config.tmux, env);

    if (tmuxResult.success) {
      if (tmuxResult.alreadyExists) {
        logger.info(`Tmux session '${sessionName}' already exists`);
      } else {
        logger.success(`Created tmux session '${sessionName}'`);
      }
    } else {
      logger.warn(`Failed to create tmux session: ${tmuxResult.error}`);
    }
  }

  if (config.ide?.command && !noIde) {
    logger.info("Opening IDE...");
    const ideResult = await openIDE(config.ide.command, env);

    if (ideResult.success) {
      logger.success("IDE opened");
    } else {
      logger.warn(`Failed to open IDE: ${ideResult.error}`);
    }
  }

  logger.success(`Environment ready for '${branch}'`);
  if (config.tmux) {
    if (process.env.TMUX) {
      const switchResult = await switchSession(sessionName);
      if (switchResult.success) {
        logger.success(`Switched to tmux session '${sessionName}'`);
      } else {
        logger.warn(`Failed to switch session: ${switchResult.error}`);
      }
    } else {
      console.log(
        `\nAttach to tmux session: ${logger.bold(`tmux attach -t ${sessionName}`)}`,
      );
    }
  }

  return ok();
}

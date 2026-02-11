import { basename } from "node:path";
import { loadConfig, resolveWorktreePath } from "../config/loader";
import { copyEntries } from "../services/copy";
import { openIDE } from "../services/ide";
import { runSetupCommands, type SetupEnv } from "../services/setup";
import {
  createSession,
  formatSessionName,
  switchSession,
} from "../services/tmux";
import {
  branchExists,
  createWorktree,
  getMainRepoPath,
  isGitRepo,
} from "../services/worktree";
import * as logger from "../utils/logger";

export interface OpenOptions {
  branch: string;
  existing: boolean;
  base?: string;
}

export async function openCommand(options: OpenOptions): Promise<void> {
  const { branch, existing, base } = options;

  if (!(await isGitRepo())) {
    logger.error("Not a git repository");
    process.exit(1);
  }

  const mainDir = await getMainRepoPath();
  if (!mainDir) {
    logger.error("Could not determine repository root");
    process.exit(1);
  }

  const { config, errors } = await loadConfig(mainDir);
  if (!config) {
    for (const err of errors) {
      logger.error(err);
    }
    process.exit(1);
  }

  if (existing && base) {
    logger.error("Options --existing and --base cannot be used together");
    process.exit(1);
  }

  if (existing) {
    const exists = await branchExists(branch);
    if (!exists) {
      logger.error(`Branch '${branch}' does not exist`);
      process.exit(1);
    }
  }

  if (base) {
    const baseExists = await branchExists(base);
    if (!baseExists) {
      logger.error(`Base branch '${base}' does not exist`);
      process.exit(1);
    }
  }

  const worktreePath = resolveWorktreePath(
    config.worktree_dir,
    branch,
    mainDir,
    config.project_name,
  );
  const sessionName = formatSessionName(basename(worktreePath));

  const env: SetupEnv = {
    WCT_WORKTREE_DIR: worktreePath,
    WCT_MAIN_DIR: mainDir,
    WCT_BRANCH: branch,
    WCT_PROJECT: config.project_name,
  };

  logger.info(
    `Creating worktree for '${branch}'${base ? ` based on '${base}'` : ""}`,
  );
  const worktreeResult = await createWorktree(
    worktreePath,
    branch,
    existing,
    base,
  );

  if (!worktreeResult.success) {
    logger.error(`Failed to create worktree: ${worktreeResult.error}`);
    process.exit(1);
  }

  if (worktreeResult.alreadyExists) {
    logger.info("Worktree already exists");
  } else {
    logger.success(`Created worktree at ${worktreePath}`);
  }

  if (config.copy && config.copy.length > 0) {
    logger.info("Copying files...");
    const copyResults = await copyEntries(config.copy, mainDir, worktreePath);
    const copied = copyResults.filter((r) => r.success).length;
    logger.success(`Copied ${copied}/${copyResults.length} files`);
  }

  if (config.setup && config.setup.length > 0) {
    logger.info("Running setup commands...");
    await runSetupCommands(config.setup, worktreePath, env);
    logger.success("Setup complete");
  }

  if (config.tmux) {
    logger.info("Creating tmux session...");
    const tmuxResult = await createSession(
      sessionName,
      worktreePath,
      config.tmux,
    );

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

  if (config.ide?.command) {
    logger.info("Opening IDE...");
    const ideResult = await openIDE(config.ide.command, env);

    if (ideResult.success) {
      logger.success("IDE opened");
    } else {
      logger.warn(`Failed to open IDE: ${ideResult.error}`);
    }
  }

  logger.success(`Worktree '${branch}' is ready`);
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
}

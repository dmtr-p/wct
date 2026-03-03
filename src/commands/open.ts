import { basename } from "node:path";
import { loadConfig, resolveWorktreePath } from "../config/loader";
import { copyEntries } from "../services/copy";
import { openIDE } from "../services/ide";
import { runSetupCommands } from "../services/setup";
import {
  createSession,
  formatSessionName,
  switchSession,
} from "../services/tmux";
import { syncWorkspaceState } from "../services/vscode-workspace";
import {
  branchExists,
  createWorktree,
  getMainRepoPath,
  isGitRepo,
} from "../services/worktree";
import type { WctEnv } from "../types/env";
import * as logger from "../utils/logger";
import { type CommandResult, err, ok } from "../utils/result";
import type { CommandDef } from "./registry";

export const commandDef: CommandDef = {
  name: "open",
  description: "Create worktree, run setup, start tmux session, open IDE",
  args: "<branch>",
  options: [
    {
      name: "base",
      short: "b",
      type: "string",
      placeholder: "branch",
      description: "Base branch for new worktree (default: HEAD)",
    },
    {
      name: "existing",
      short: "e",
      type: "boolean",
      description: "Use existing branch",
    },
    {
      name: "no-ide",
      type: "boolean",
      description: "Skip opening IDE",
    },
    {
      name: "pr",
      type: "string",
      placeholder: "number-or-url",
      description: "Open worktree from a GitHub PR",
    },
  ],
};

export interface OpenOptions {
  branch: string;
  existing: boolean;
  base?: string;
  noIde?: boolean;
}

export async function openCommand(
  options: OpenOptions,
): Promise<CommandResult> {
  const { branch, existing, base, noIde } = options;

  if (!(await isGitRepo())) {
    return err("Not a git repository", "not_git_repo");
  }

  const mainDir = await getMainRepoPath();
  if (!mainDir) {
    return err("Could not determine repository root", "worktree_error");
  }

  const { config, errors } = await loadConfig(mainDir);
  if (!config) {
    return err(errors.join("\n"), "config_error");
  }

  if (existing && base) {
    return err(
      "Options --existing and --base cannot be used together",
      "invalid_options",
    );
  }

  if (existing) {
    const exists = await branchExists(branch);
    if (!exists) {
      return err(`Branch '${branch}' does not exist`, "branch_not_found");
    }
  }

  if (base) {
    const baseExists = await branchExists(base);
    if (!baseExists) {
      return err(
        `Base branch '${base}' does not exist`,
        "base_branch_not_found",
      );
    }
  }

  const worktreePath = resolveWorktreePath(
    config.worktree_dir,
    branch,
    mainDir,
    config.project_name,
  );
  const sessionName = formatSessionName(basename(worktreePath));

  const env: WctEnv = {
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
    return err(
      `Failed to create worktree: ${worktreeResult.error}`,
      "worktree_error",
    );
  }

  if (worktreeResult.alreadyExists) {
    logger.info("Worktree already exists");
  } else {
    logger.success(`Created worktree at ${worktreePath}`);
  }

  if (
    (config.ide?.name ?? "vscode") === "vscode" &&
    config.ide?.fork_workspace
  ) {
    logger.info("Syncing VS Code workspace state...");
    const syncResult = await syncWorkspaceState(mainDir, worktreePath);

    if (syncResult.success && !syncResult.skipped) {
      logger.success("VS Code workspace state synced");
    } else if (syncResult.skipped) {
      logger.info("VS Code workspace already exists, skipping sync");
    } else {
      logger.warn(`VS Code workspace sync failed: ${syncResult.error}`);
    }
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
      env,
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

  if (config.ide?.command && !noIde) {
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

  return ok();
}

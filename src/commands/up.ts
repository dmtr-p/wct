import { loadConfig } from "../config/loader";
import { openIDE } from "../services/ide";
import type { SetupEnv } from "../services/setup";
import { createSession, formatSessionName } from "../services/tmux";
import {
	getCurrentBranch,
	getMainWorktreePath,
	isGitRepo,
} from "../services/worktree";
import * as logger from "../utils/logger";

export async function upCommand(): Promise<void> {
	if (!(await isGitRepo())) {
		logger.error("Not a git repository");
		process.exit(1);
	}

	const cwd = process.cwd();

	const mainWorktreePath = await getMainWorktreePath();
	if (!mainWorktreePath) {
		logger.error("Could not determine main repository path");
		process.exit(1);
	}

	const { config, errors } = await loadConfig(mainWorktreePath);
	if (!config) {
		for (const err of errors) {
			logger.error(err);
		}
		process.exit(1);
	}

	const branch = await getCurrentBranch();
	if (!branch) {
		logger.error(
			"Could not determine current branch (detached HEAD is not supported)",
		);
		process.exit(1);
	}

	const sessionName = formatSessionName(config.project_name, branch);

	const env: SetupEnv = {
		WCT_WORKTREE_DIR: cwd,
		WCT_MAIN_DIR: mainWorktreePath,
		WCT_BRANCH: branch,
		WCT_PROJECT: config.project_name,
	};

	if (config.tmux) {
		logger.info("Creating tmux session...");
		const tmuxResult = await createSession(sessionName, cwd, config.tmux);

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

	logger.success(`Environment ready for '${branch}'`);
	if (config.tmux) {
		console.log(
			`\nAttach to tmux session: ${logger.bold(`tmux attach -t ${sessionName}`)}`,
		);
	}
}

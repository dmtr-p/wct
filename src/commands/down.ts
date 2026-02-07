import { basename } from "node:path";
import {
	formatSessionName,
	killSession,
	sessionExists,
} from "../services/tmux";
import { isGitRepo } from "../services/worktree";
import * as logger from "../utils/logger";

export async function downCommand(): Promise<void> {
	if (!(await isGitRepo())) {
		logger.error("Not a git repository");
		process.exit(1);
	}

	const cwd = process.cwd();
	const sessionName = formatSessionName(basename(cwd));

	if (!(await sessionExists(sessionName))) {
		logger.warn(`No tmux session '${sessionName}' found`);
		return;
	}

	logger.info(`Killing tmux session '${sessionName}'...`);
	const result = await killSession(sessionName);

	if (result.success) {
		logger.success(`Killed tmux session '${sessionName}'`);
	} else {
		logger.error(`Failed to kill tmux session: ${result.error}`);
		process.exit(1);
	}
}

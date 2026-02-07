import { basename } from "node:path";
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

export interface CloseOptions {
	branch: string;
	yes?: boolean;
	force?: boolean;
}

export async function closeCommand(options: CloseOptions): Promise<void> {
	const { branch, yes = false, force = false } = options;

	if (!(await isGitRepo())) {
		logger.error("Not a git repository");
		process.exit(1);
	}

	const worktree = await findWorktreeByBranch(branch);
	if (!worktree) {
		logger.error(`No worktree found for branch '${branch}'`);
		process.exit(1);
	}

	const worktreePath = worktree.path;
	const sessionName = formatSessionName(basename(worktreePath));

	if (!yes) {
		const confirmed = await confirm(
			`Close worktree '${branch}' and kill tmux session '${sessionName}'?`,
		);
		if (!confirmed) {
			logger.info("Aborted");
			return;
		}
	}

	const currentSession = await getCurrentSession();
	if (currentSession === sessionName && !yes) {
		const confirmed = await confirm(
			"You are inside this tmux session. It will be killed. Continue?",
		);
		if (!confirmed) {
			logger.info("Aborted");
			return;
		}
	}

	if (await sessionExists(sessionName)) {
		logger.info(`Killing tmux session '${sessionName}'...`);
		const killResult = await killSession(sessionName);
		if (killResult.success) {
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
	} else {
		if (removeResult.error?.includes("contains modified or untracked files")) {
			logger.error(
				"Worktree has uncommitted changes. Use --force to remove anyway.",
			);
		} else {
			logger.error(`Failed to remove worktree: ${removeResult.error}`);
		}
		process.exit(1);
	}
}

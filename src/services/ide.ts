import { $ } from "bun";
import * as logger from "../utils/logger";
import type { SetupEnv } from "./setup";

export interface OpenIdeResult {
	success: boolean;
	error?: string;
}

function substituteEnvVars(command: string, env: SetupEnv): string {
	return command
		.replace(/\$TAB_WORKTREE_DIR/g, env.TAB_WORKTREE_DIR)
		.replace(/\$TAB_MAIN_DIR/g, env.TAB_MAIN_DIR)
		.replace(/\$TAB_BRANCH/g, env.TAB_BRANCH)
		.replace(/\$TAB_PROJECT/g, env.TAB_PROJECT)
		.replace(/\$\{TAB_WORKTREE_DIR\}/g, env.TAB_WORKTREE_DIR)
		.replace(/\$\{TAB_MAIN_DIR\}/g, env.TAB_MAIN_DIR)
		.replace(/\$\{TAB_BRANCH\}/g, env.TAB_BRANCH)
		.replace(/\$\{TAB_PROJECT\}/g, env.TAB_PROJECT);
}

export async function openIDE(
	command: string,
	env: SetupEnv,
): Promise<OpenIdeResult> {
	const expandedCommand = substituteEnvVars(command, env);

	try {
		await $`sh -c ${expandedCommand}`.quiet();
		return { success: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(`Failed to open IDE: ${message}`);
		return { success: false, error: message };
	}
}

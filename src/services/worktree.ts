import { $ } from "bun";

interface ShellError extends Error {
	stderr?: Buffer;
	exitCode?: number;
}

function extractShellError(err: unknown): string {
	if (err && typeof err === "object") {
		const shellErr = err as ShellError;
		if (shellErr.stderr) {
			const stderr = shellErr.stderr.toString().trim();
			if (stderr) {
				// Filter to only fatal/error lines from git
				const errorLines = stderr
					.split("\n")
					.filter((line) => /^(fatal|error):/.test(line));
				if (errorLines.length > 0) {
					return errorLines.join("\n");
				}
				return stderr;
			}
		}
		if (shellErr.message) {
			return shellErr.message;
		}
	}
	return String(err);
}

export interface Worktree {
	path: string;
	branch: string;
	commit: string;
	isBare: boolean;
}

export async function getMainRepoPath(): Promise<string | null> {
	try {
		const result = await $`git rev-parse --show-toplevel`.quiet();
		return result.text().trim();
	} catch {
		return null;
	}
}

export async function getCurrentBranch(): Promise<string | null> {
	try {
		const result = await $`git rev-parse --abbrev-ref HEAD`.quiet();
		const branch = result.text().trim();
		if (!branch || branch === "HEAD") {
			return null;
		}
		return branch;
	} catch {
		return null;
	}
}

export async function getMainWorktreePath(): Promise<string | null> {
	const worktrees = await listWorktrees();
	if (worktrees.length === 0) {
		return null;
	}
	return worktrees[0].path;
}

export async function isGitRepo(): Promise<boolean> {
	try {
		await $`git rev-parse --git-dir`.quiet();
		return true;
	} catch {
		return false;
	}
}

export function parseWorktreeListOutput(output: string): Worktree[] {
	const worktrees: Worktree[] = [];
	let current: Partial<Worktree> = {};

	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) {
				worktrees.push(current as Worktree);
			}
			current = { path: line.slice(9), isBare: false };
		} else if (line.startsWith("HEAD ")) {
			current.commit = line.slice(5);
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice(7).replace("refs/heads/", "");
		} else if (line === "bare") {
			current.isBare = true;
		} else if (line === "detached") {
			current.branch = "(detached)";
		}
	}

	if (current.path) {
		worktrees.push(current as Worktree);
	}

	return worktrees;
}

export async function listWorktrees(): Promise<Worktree[]> {
	try {
		const result = await $`git worktree list --porcelain`.quiet();
		const output = result.text();
		return parseWorktreeListOutput(output);
	} catch {
		return [];
	}
}

export interface CreateWorktreeResult {
	success: boolean;
	path: string;
	error?: string;
	alreadyExists?: boolean;
}

export async function createWorktree(
	path: string,
	branch: string,
	useExisting: boolean,
	base?: string,
): Promise<CreateWorktreeResult> {
	const worktreeDir = Bun.file(path);
	if (await worktreeDir.exists()) {
		return {
			success: true,
			path,
			alreadyExists: true,
		};
	}

	try {
		if (useExisting) {
			await $`git worktree add ${path} ${branch}`.quiet();
		} else if (base) {
			await $`git worktree add -b ${branch} ${path} ${base}`.quiet();
		} else {
			await $`git worktree add -b ${branch} ${path}`.quiet();
		}

		return { success: true, path };
	} catch (err) {
		const message = extractShellError(err);
		return { success: false, path, error: message };
	}
}

export async function branchExists(branch: string): Promise<boolean> {
	try {
		await $`git rev-parse --verify ${branch}`.quiet();
		return true;
	} catch {
		return false;
	}
}

export async function remoteBranchExists(branch: string): Promise<boolean> {
	try {
		await $`git rev-parse --verify origin/${branch}`.quiet();
		return true;
	} catch {
		return false;
	}
}

export interface RemoveWorktreeResult {
	success: boolean;
	path: string;
	error?: string;
}

export async function removeWorktree(
	path: string,
	force = false,
): Promise<RemoveWorktreeResult> {
	try {
		if (force) {
			await $`git worktree remove --force ${path}`.quiet();
		} else {
			await $`git worktree remove ${path}`.quiet();
		}
		return { success: true, path };
	} catch (err) {
		const message = extractShellError(err);
		return { success: false, path, error: message };
	}
}

export async function findWorktreeByBranch(
	branch: string,
): Promise<Worktree | null> {
	const worktrees = await listWorktrees();
	return worktrees.find((wt) => wt.branch === branch) ?? null;
}

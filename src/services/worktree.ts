import { $ } from "bun";

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

export async function isGitRepo(): Promise<boolean> {
	try {
		await $`git rev-parse --git-dir`.quiet();
		return true;
	} catch {
		return false;
	}
}

export async function listWorktrees(): Promise<Worktree[]> {
	try {
		const result = await $`git worktree list --porcelain`.quiet();
		const output = result.text();
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
		} else {
			await $`git worktree add -b ${branch} ${path}`.quiet();
		}

		return { success: true, path };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
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

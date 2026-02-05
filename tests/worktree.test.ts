import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createWorktree,
	findWorktreeByBranch,
	parseWorktreeListOutput,
} from "../src/services/worktree";

describe("parseWorktreeListOutput", () => {
	test("parses porcelain output correctly", () => {
		const output = `worktree /home/user/projects/myapp
HEAD abc123def456
branch refs/heads/main

worktree /home/user/worktrees/myapp/feature-auth
HEAD def456abc123
branch refs/heads/feature-auth

worktree /home/user/worktrees/myapp/detached
HEAD 789abcdef012
detached
`;

		const worktrees = parseWorktreeListOutput(output);

		expect(worktrees).toHaveLength(3);

		expect(worktrees[0].path).toBe("/home/user/projects/myapp");
		expect(worktrees[0].branch).toBe("main");
		expect(worktrees[0].commit).toBe("abc123def456");

		expect(worktrees[1].path).toBe("/home/user/worktrees/myapp/feature-auth");
		expect(worktrees[1].branch).toBe("feature-auth");

		expect(worktrees[2].path).toBe("/home/user/worktrees/myapp/detached");
		expect(worktrees[2].branch).toBe("(detached)");
	});

	test("handles bare repository", () => {
		const output = `worktree /home/user/repos/myapp.git
bare
`;

		const worktrees = parseWorktreeListOutput(output);

		expect(worktrees).toHaveLength(1);
		expect(worktrees[0].isBare).toBe(true);
	});

	test("handles empty output", () => {
		const worktrees = parseWorktreeListOutput("");
		expect(worktrees).toHaveLength(0);
	});
});

describe("findWorktreeByBranch", () => {
	test("returns null when no worktrees exist", async () => {
		const result = await findWorktreeByBranch("nonexistent-branch-xyz");
		expect(result).toBeNull();
	});
});

describe("createWorktree with base branch", () => {
	let repoDir: string;
	let worktreeDir: string;
	const originalDir = process.cwd();

	beforeAll(async () => {
		// Create a temporary git repo with two branches at different commits
		repoDir = await mkdtemp(join(tmpdir(), "wct-test-repo-"));
		worktreeDir = await mkdtemp(join(tmpdir(), "wct-test-wt-"));

		process.chdir(repoDir);
		await $`git init -b main`.quiet().cwd(repoDir);
		await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
		await $`git config user.name "Test"`.quiet().cwd(repoDir);
		await $`git config commit.gpgSign false`.quiet().cwd(repoDir);

		// Initial commit on main
		await $`git commit --allow-empty -m "initial commit"`.quiet().cwd(repoDir);

		// Create a "develop" branch with an extra commit
		await $`git checkout -b develop`.quiet().cwd(repoDir);
		await $`git commit --allow-empty -m "develop commit"`.quiet().cwd(repoDir);

		// Go back to main
		await $`git checkout main`.quiet().cwd(repoDir);
	});

	afterAll(async () => {
		process.chdir(originalDir);
		await rm(repoDir, { recursive: true, force: true });
		await rm(worktreeDir, { recursive: true, force: true });
	});

	test("creates worktree with base branch", async () => {
		process.chdir(repoDir);
		const wtPath = join(worktreeDir, "feature-from-develop");
		const result = await createWorktree(
			wtPath,
			"feature-from-develop",
			false,
			"develop",
		);

		expect(result.success).toBe(true);
		expect(result.path).toBe(wtPath);
		expect(result.alreadyExists).toBeUndefined();

		// Verify the new branch is based on develop (has develop's commit)
		const log =
			await $`git log --oneline feature-from-develop`.quiet().cwd(repoDir);
		const logText = log.text();
		expect(logText).toContain("develop commit");
	});

	test("creates worktree without base (defaults to HEAD)", async () => {
		process.chdir(repoDir);
		const wtPath = join(worktreeDir, "feature-from-head");
		const result = await createWorktree(
			wtPath,
			"feature-from-head",
			false,
		);

		expect(result.success).toBe(true);

		// Should be based on current HEAD (main), which does not have develop's commit
		const log =
			await $`git log --oneline feature-from-head`.quiet().cwd(repoDir);
		const logText = log.text();
		expect(logText).not.toContain("develop commit");
	});

	test("returns error when base branch does not exist", async () => {
		process.chdir(repoDir);
		const wtPath = join(worktreeDir, "feature-bad-base");
		const result = await createWorktree(
			wtPath,
			"feature-bad-base",
			false,
			"nonexistent-branch",
		);

		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});

	test("ignores base when using existing branch", async () => {
		process.chdir(repoDir);
		const wtPath = join(worktreeDir, "existing-branch-wt");
		const result = await createWorktree(
			wtPath,
			"develop",
			true,
		);

		expect(result.success).toBe(true);
		expect(result.path).toBe(wtPath);
	});
});

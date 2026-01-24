import { describe, expect, test } from "bun:test";
import {
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

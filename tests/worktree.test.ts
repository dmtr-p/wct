import { describe, expect, test } from "bun:test";

describe("worktree parsing", () => {
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

		const worktrees: Array<{
			path: string;
			branch: string;
			commit: string;
			isBare: boolean;
		}> = [];
		let current: {
			path?: string;
			branch?: string;
			commit?: string;
			isBare: boolean;
		} = { isBare: false };

		for (const line of output.split("\n")) {
			if (line.startsWith("worktree ")) {
				if (current.path) {
					worktrees.push(current as (typeof worktrees)[0]);
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
			worktrees.push(current as (typeof worktrees)[0]);
		}

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

		const worktrees: Array<{
			path: string;
			isBare: boolean;
		}> = [];
		let current: { path?: string; isBare: boolean } = { isBare: false };

		for (const line of output.split("\n")) {
			if (line.startsWith("worktree ")) {
				if (current.path) {
					worktrees.push(current as (typeof worktrees)[0]);
				}
				current = { path: line.slice(9), isBare: false };
			} else if (line === "bare") {
				current.isBare = true;
			}
		}

		if (current.path) {
			worktrees.push(current as (typeof worktrees)[0]);
		}

		expect(worktrees).toHaveLength(1);
		expect(worktrees[0].isBare).toBe(true);
	});
});

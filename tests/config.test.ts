import { describe, expect, test } from "bun:test";
import {
	expandTilde,
	resolveWorktreePath,
	slugifyBranch,
} from "../src/config/loader";
import { resolveConfig, validateConfig } from "../src/config/validator";

describe("validateConfig", () => {
	test("accepts valid minimal config", () => {
		const result = validateConfig({});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test("accepts valid full config", () => {
		const result = validateConfig({
			version: 1,
			worktree_dir: "../worktrees",
			project_name: "myapp",
			copy: [".env", ".env.local"],
			setup: [
				{ name: "Install", command: "bun install" },
				{ name: "Codegen", command: "bun run codegen", optional: true },
			],
			ide: { command: "code $WCT_WORKTREE_DIR" },
			tmux: {
				windows: [
					{
						name: "dev",
						split: "horizontal",
						panes: [{ command: "bun run dev" }, { name: "shell" }],
					},
				],
			},
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test("rejects non-object config", () => {
		const result = validateConfig("not an object");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Config must be an object");
	});

	test("rejects invalid version type", () => {
		const result = validateConfig({ version: "1" });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("version must be a number");
	});

	test("rejects invalid worktree_dir type", () => {
		const result = validateConfig({ worktree_dir: 123 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("worktree_dir must be a string");
	});

	test("rejects invalid copy array items", () => {
		const result = validateConfig({ copy: [".env", 123, ".env.local"] });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("copy[1] must be a string");
	});

	test("rejects invalid setup command", () => {
		const result = validateConfig({
			setup: [{ name: "Install" }],
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("setup[0].command must be a string");
	});

	test("accepts valid tmux windows config", () => {
		const result = validateConfig({
			tmux: {
				windows: [
					{
						name: "dev",
						split: "horizontal",
						panes: [
							{ command: "bun run dev" },
							{ name: "watch", command: "bun run watch" },
						],
					},
					{
						name: "testing",
						panes: [{ command: "bun test --watch" }],
					},
					{
						name: "shell",
						command: "echo hello",
					},
				],
			},
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test("rejects tmux window without name", () => {
		const result = validateConfig({
			tmux: {
				windows: [{ command: "echo hello" }],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("tmux.windows[0].name must be a string");
	});

	test("rejects invalid tmux window split value", () => {
		const result = validateConfig({
			tmux: {
				windows: [{ name: "dev", split: "diagonal" }],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			'tmux.windows[0].split must be "horizontal" or "vertical"',
		);
	});

	test("rejects invalid tmux window pane command type", () => {
		const result = validateConfig({
			tmux: {
				windows: [
					{
						name: "dev",
						panes: [{ command: 123 }],
					},
				],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"tmux.windows[0].panes[0].command must be a string",
		);
	});

	test("rejects non-array tmux windows", () => {
		const result = validateConfig({
			tmux: { windows: "not-an-array" },
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("tmux.windows must be an array");
	});

	test("rejects non-array tmux window panes", () => {
		const result = validateConfig({
			tmux: {
				windows: [{ name: "dev", panes: "not-an-array" }],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("tmux.windows[0].panes must be an array");
	});

	test("accepts valid tmux window layout presets", () => {
		const layouts = [
			"even-horizontal",
			"even-vertical",
			"main-horizontal",
			"main-vertical",
			"tiled",
		];
		for (const layout of layouts) {
			const result = validateConfig({
				tmux: {
					windows: [{ name: "dev", layout, panes: [{}, {}] }],
				},
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		}
	});

	test("rejects invalid tmux window layout", () => {
		const result = validateConfig({
			tmux: {
				windows: [{ name: "dev", layout: "invalid-layout" }],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"tmux.windows[0].layout must be one of: even-horizontal, even-vertical, main-horizontal, main-vertical, tiled",
		);
	});

	test("rejects invalid tmux window object type", () => {
		const result = validateConfig({
			tmux: { windows: ["not-an-object"] },
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("tmux.windows[0] must be an object");
	});

	test("rejects invalid tmux pane object type", () => {
		const result = validateConfig({
			tmux: {
				windows: [{ name: "dev", panes: ["not-an-object"] }],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"tmux.windows[0].panes[0] must be an object",
		);
	});

	test("rejects invalid tmux window command type", () => {
		const result = validateConfig({
			tmux: {
				windows: [{ name: "dev", command: 123 }],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("tmux.windows[0].command must be a string");
	});

	test("rejects invalid tmux pane name type", () => {
		const result = validateConfig({
			tmux: {
				windows: [{ name: "dev", panes: [{ name: 123 }] }],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"tmux.windows[0].panes[0].name must be a string",
		);
	});

	test("rejects tmux window name with colon", () => {
		const result = validateConfig({
			tmux: {
				windows: [{ name: "dev:server" }],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"tmux.windows[0].name contains invalid characters (: . #). These characters conflict with tmux target syntax.",
		);
	});

	test("rejects tmux window name with period", () => {
		const result = validateConfig({
			tmux: {
				windows: [{ name: "dev.server" }],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"tmux.windows[0].name contains invalid characters (: . #). These characters conflict with tmux target syntax.",
		);
	});

	test("rejects tmux window name with hash", () => {
		const result = validateConfig({
			tmux: {
				windows: [{ name: "dev#1" }],
			},
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"tmux.windows[0].name contains invalid characters (: . #). These characters conflict with tmux target syntax.",
		);
	});

	test("accepts valid tmux window names with hyphens and underscores", () => {
		const result = validateConfig({
			tmux: {
				windows: [
					{ name: "dev-server" },
					{ name: "test_runner" },
					{ name: "shell123" },
				],
			},
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

describe("resolveConfig", () => {
	test("uses defaults when not specified", () => {
		const result = resolveConfig({}, "/home/user/projects/myapp");
		expect(result.project_name).toBe("myapp");
		expect(result.worktree_dir).toBe("../worktrees");
	});

	test("preserves specified values", () => {
		const result = resolveConfig(
			{
				project_name: "custom",
				worktree_dir: "~/worktrees",
			},
			"/home/user/projects/myapp",
		);
		expect(result.project_name).toBe("custom");
		expect(result.worktree_dir).toBe("~/worktrees");
	});
});

describe("expandTilde", () => {
	test("expands tilde prefix", () => {
		const result = expandTilde("~/worktrees");
		expect(result).not.toStartWith("~");
		expect(result).toContain("worktrees");
	});

	test("leaves absolute paths unchanged", () => {
		const result = expandTilde("/var/worktrees");
		expect(result).toBe("/var/worktrees");
	});

	test("leaves relative paths unchanged", () => {
		const result = expandTilde("../worktrees");
		expect(result).toBe("../worktrees");
	});
});

describe("slugifyBranch", () => {
	test("replaces slashes with hyphens", () => {
		expect(slugifyBranch("feature/auth")).toBe("feature-auth");
	});

	test("replaces multiple special characters", () => {
		expect(slugifyBranch("feature@auth#test")).toBe("feature-auth-test");
	});

	test("leaves simple names unchanged", () => {
		expect(slugifyBranch("feature-auth")).toBe("feature-auth");
	});

	test("preserves underscores", () => {
		expect(slugifyBranch("feature_auth")).toBe("feature_auth");
	});

	test("handles nested slashes", () => {
		expect(slugifyBranch("feature/auth/login")).toBe("feature-auth-login");
	});
});

describe("resolveWorktreePath", () => {
	test("includes project name prefix and slugified branch", () => {
		const result = resolveWorktreePath(
			"../worktrees",
			"feature/auth",
			"/home/user/projects/myapp",
			"myapp",
		);
		expect(result).toBe("/home/user/projects/worktrees/myapp-feature-auth");
	});

	test("does not create nested directories from slashes in branch", () => {
		const result = resolveWorktreePath(
			"../worktrees",
			"feature/auth/login",
			"/home/user/projects/myapp",
			"myapp",
		);
		expect(result).toBe(
			"/home/user/projects/worktrees/myapp-feature-auth-login",
		);
		expect(result).not.toContain("feature/auth");
	});

	test("handles absolute worktree dir", () => {
		const result = resolveWorktreePath(
			"/var/worktrees",
			"main",
			"/home/user/projects/myapp",
			"myapp",
		);
		expect(result).toBe("/var/worktrees/myapp-main");
	});

	test("slugifies project name with special characters", () => {
		const result = resolveWorktreePath(
			"../worktrees",
			"main",
			"/home/user/projects/my.app",
			"my/app",
		);
		expect(result).toBe("/home/user/projects/worktrees/my-app-main");
	});
});

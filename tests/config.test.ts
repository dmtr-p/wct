import { describe, expect, test } from "bun:test";
import { expandTilde } from "../src/config/loader";
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
			ide: { command: "code $TAB_WORKTREE_DIR" },
			tmux: {
				layout: "panes",
				split: "horizontal",
				panes: [{ name: "dev", command: "bun run dev" }, { name: "shell" }],
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

	test("rejects invalid tmux layout", () => {
		const result = validateConfig({
			tmux: { layout: "invalid" },
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('tmux.layout must be "panes" or "windows"');
	});

	test("rejects invalid tmux split", () => {
		const result = validateConfig({
			tmux: { split: "diagonal" },
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			'tmux.split must be "horizontal" or "vertical"',
		);
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

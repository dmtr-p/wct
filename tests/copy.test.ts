import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	copyEntries,
	detectEntryType,
	expandEntry,
} from "../src/services/copy";

describe("detectEntryType", () => {
	test("detects file entries", () => {
		expect(detectEntryType(".env")).toBe("file");
		expect(detectEntryType("config/settings.json")).toBe("file");
		expect(detectEntryType(".gitignore")).toBe("file");
	});

	test("detects directory entries with trailing slash", () => {
		expect(detectEntryType(".vscode/")).toBe("directory");
		expect(detectEntryType("config/")).toBe("directory");
		expect(detectEntryType("nested/path/dir/")).toBe("directory");
	});

	test("detects glob patterns with asterisk", () => {
		expect(detectEntryType("*.json")).toBe("glob");
		expect(detectEntryType(".claude/**/*.json")).toBe("glob");
		expect(detectEntryType("src/*.ts")).toBe("glob");
	});

	test("detects glob patterns with question mark", () => {
		expect(detectEntryType("file?.txt")).toBe("glob");
	});

	test("detects glob patterns with brackets", () => {
		expect(detectEntryType("[abc].txt")).toBe("glob");
		expect(detectEntryType("file[0-9].txt")).toBe("glob");
	});

	test("detects glob patterns with braces", () => {
		expect(detectEntryType("*.{js,ts}")).toBe("glob");
		expect(detectEntryType("{src,lib}/**/*.ts")).toBe("glob");
	});
});

describe("expandEntry", () => {
	const tempDir = join(import.meta.dir, ".temp-test-expand");

	beforeEach(async () => {
		await mkdir(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns single file for file entry", async () => {
		await Bun.write(join(tempDir, ".env"), "TEST=1");

		const files = await expandEntry(".env", tempDir);
		expect(files).toEqual([".env"]);
	});

	test("returns file path even if file does not exist", async () => {
		const files = await expandEntry("nonexistent.txt", tempDir);
		expect(files).toEqual(["nonexistent.txt"]);
	});

	test("expands directory to all files recursively", async () => {
		await mkdir(join(tempDir, ".vscode"), { recursive: true });
		await Bun.write(join(tempDir, ".vscode/settings.json"), "{}");
		await Bun.write(join(tempDir, ".vscode/extensions.json"), "[]");

		const files = await expandEntry(".vscode/", tempDir);
		expect(files.sort()).toEqual(
			[".vscode/settings.json", ".vscode/extensions.json"].sort(),
		);
	});

	test("returns empty array for non-existent directory", async () => {
		const files = await expandEntry("nonexistent/", tempDir);
		expect(files).toEqual([]);
	});

	test("expands glob pattern to matching files", async () => {
		await mkdir(join(tempDir, ".claude/nested"), { recursive: true });
		await Bun.write(join(tempDir, ".claude/config.json"), "{}");
		await Bun.write(join(tempDir, ".claude/nested/settings.json"), "{}");
		await Bun.write(join(tempDir, ".claude/readme.md"), "# README");

		const files = await expandEntry(".claude/**/*.json", tempDir);
		expect(files.sort()).toEqual(
			[".claude/config.json", ".claude/nested/settings.json"].sort(),
		);
	});

	test("returns empty array for glob with no matches", async () => {
		const files = await expandEntry("**/*.nonexistent", tempDir);
		expect(files).toEqual([]);
	});

	test("expands nested directory structure", async () => {
		await mkdir(join(tempDir, "config/nested/deep"), { recursive: true });
		await Bun.write(join(tempDir, "config/a.json"), "{}");
		await Bun.write(join(tempDir, "config/nested/b.json"), "{}");
		await Bun.write(join(tempDir, "config/nested/deep/c.json"), "{}");

		const files = await expandEntry("config/", tempDir);
		expect(files.sort()).toEqual(
			[
				"config/a.json",
				"config/nested/b.json",
				"config/nested/deep/c.json",
			].sort(),
		);
	});

	test("includes dotfiles inside directories", async () => {
		await mkdir(join(tempDir, "config"), { recursive: true });
		await Bun.write(join(tempDir, "config/.hidden"), "secret");
		await Bun.write(join(tempDir, "config/.env.local"), "KEY=value");
		await Bun.write(join(tempDir, "config/visible.json"), "{}");

		const files = await expandEntry("config/", tempDir);
		expect(files.sort()).toEqual(
			["config/.hidden", "config/.env.local", "config/visible.json"].sort(),
		);
	});
});

describe("copyEntries", () => {
	const tempDir = join(import.meta.dir, ".temp-test-copy");
	const sourceDir = join(tempDir, "source");
	const targetDir = join(tempDir, "target");

	beforeEach(async () => {
		await mkdir(sourceDir, { recursive: true });
		await mkdir(targetDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("copies single file", async () => {
		await Bun.write(join(sourceDir, ".env"), "SECRET=123");

		const results = await copyEntries([".env"], sourceDir, targetDir);

		expect(results).toHaveLength(1);
		expect(results[0].success).toBe(true);
		expect(results[0].file).toBe(".env");

		const content = await Bun.file(join(targetDir, ".env")).text();
		expect(content).toBe("SECRET=123");
	});

	test("copies directory contents", async () => {
		await mkdir(join(sourceDir, ".vscode"), { recursive: true });
		await Bun.write(
			join(sourceDir, ".vscode/settings.json"),
			'{"editor.tabSize": 2}',
		);
		await Bun.write(join(sourceDir, ".vscode/extensions.json"), "[]");

		const results = await copyEntries([".vscode/"], sourceDir, targetDir);

		expect(results).toHaveLength(2);
		expect(results.every((r) => r.success)).toBe(true);

		const settings = await Bun.file(
			join(targetDir, ".vscode/settings.json"),
		).text();
		expect(settings).toBe('{"editor.tabSize": 2}');

		const extensions = await Bun.file(
			join(targetDir, ".vscode/extensions.json"),
		).text();
		expect(extensions).toBe("[]");
	});

	test("copies files matching glob pattern", async () => {
		await mkdir(join(sourceDir, ".claude/nested"), { recursive: true });
		await Bun.write(join(sourceDir, ".claude/config.json"), '{"key": "value"}');
		await Bun.write(
			join(sourceDir, ".claude/nested/data.json"),
			'{"data": true}',
		);
		await Bun.write(join(sourceDir, ".claude/readme.md"), "# Skip this");

		const results = await copyEntries(
			[".claude/**/*.json"],
			sourceDir,
			targetDir,
		);

		expect(results).toHaveLength(2);
		expect(results.every((r) => r.success)).toBe(true);

		const config = await Bun.file(
			join(targetDir, ".claude/config.json"),
		).text();
		expect(config).toBe('{"key": "value"}');

		const data = await Bun.file(
			join(targetDir, ".claude/nested/data.json"),
		).text();
		expect(data).toBe('{"data": true}');

		// Ensure .md file was not copied
		const mdExists = await Bun.file(
			join(targetDir, ".claude/readme.md"),
		).exists();
		expect(mdExists).toBe(false);
	});

	test("copies mixed entry types", async () => {
		await Bun.write(join(sourceDir, ".env"), "ENV=prod");
		await mkdir(join(sourceDir, ".vscode"), { recursive: true });
		await Bun.write(join(sourceDir, ".vscode/settings.json"), "{}");
		await mkdir(join(sourceDir, "config"), { recursive: true });
		await Bun.write(join(sourceDir, "config/app.json"), "{}");
		await Bun.write(join(sourceDir, "config/db.json"), "{}");

		const results = await copyEntries(
			[".env", ".vscode/", "config/*.json"],
			sourceDir,
			targetDir,
		);

		expect(results).toHaveLength(4);
		expect(results.filter((r) => r.success)).toHaveLength(4);
	});

	test("deduplicates overlapping patterns", async () => {
		await mkdir(join(sourceDir, "src"), { recursive: true });
		await Bun.write(join(sourceDir, "src/index.ts"), "export {}");

		const results = await copyEntries(
			["src/", "src/**/*.ts", "src/index.ts"],
			sourceDir,
			targetDir,
		);

		// Should only copy once despite matching all three patterns
		expect(results).toHaveLength(1);
		expect(results[0].success).toBe(true);
	});

	test("handles missing file gracefully", async () => {
		const results = await copyEntries(["missing.txt"], sourceDir, targetDir);

		expect(results).toHaveLength(1);
		expect(results[0].success).toBe(false);
		expect(results[0].error).toBe("File not found");
	});

	test("handles missing directory gracefully", async () => {
		const results = await copyEntries(["missing/"], sourceDir, targetDir);

		// Empty result since directory doesn't exist
		expect(results).toHaveLength(0);
	});

	test("handles glob with no matches gracefully", async () => {
		const results = await copyEntries(
			["**/*.nonexistent"],
			sourceDir,
			targetDir,
		);

		expect(results).toHaveLength(0);
	});

	test("creates nested target directories", async () => {
		await mkdir(join(sourceDir, "deep/nested/path"), { recursive: true });
		await Bun.write(join(sourceDir, "deep/nested/path/file.txt"), "content");

		const results = await copyEntries(["deep/"], sourceDir, targetDir);

		expect(results).toHaveLength(1);
		expect(results[0].success).toBe(true);

		const content = await Bun.file(
			join(targetDir, "deep/nested/path/file.txt"),
		).text();
		expect(content).toBe("content");
	});
});

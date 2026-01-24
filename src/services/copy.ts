import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as logger from "../utils/logger";

export interface CopyResult {
	file: string;
	success: boolean;
	error?: string;
}

export type CopyEntryType = "file" | "directory" | "glob";

export function detectEntryType(entry: string): CopyEntryType {
	if (entry.endsWith("/")) return "directory";
	if (/[*?[\]{}]/.test(entry)) return "glob";
	return "file";
}

async function expandDirectory(
	dirPath: string,
	baseDir: string,
): Promise<string[]> {
	const normalizedDir = dirPath.endsWith("/") ? dirPath.slice(0, -1) : dirPath;
	const fullPath = join(baseDir, normalizedDir);

	try {
		const stats = await stat(fullPath);
		if (!stats.isDirectory()) {
			return [];
		}
	} catch {
		return [];
	}

	const glob = new Bun.Glob("**/*");
	const files: string[] = [];

	for await (const file of glob.scan({
		cwd: fullPath,
		onlyFiles: true,
		dot: true,
	})) {
		files.push(join(normalizedDir, file));
	}

	return files;
}

async function expandGlob(pattern: string, baseDir: string): Promise<string[]> {
	const glob = new Bun.Glob(pattern);
	const files: string[] = [];

	for await (const file of glob.scan({
		cwd: baseDir,
		onlyFiles: true,
		dot: true,
	})) {
		files.push(file);
	}

	return files;
}

export async function expandEntry(
	entry: string,
	baseDir: string,
): Promise<string[]> {
	const entryType = detectEntryType(entry);

	switch (entryType) {
		case "directory":
			return expandDirectory(entry, baseDir);
		case "glob":
			return expandGlob(entry, baseDir);
		case "file":
			return [entry];
	}
}

export async function copyEntries(
	entries: string[],
	sourceDir: string,
	targetDir: string,
): Promise<CopyResult[]> {
	const allFiles: string[] = [];

	for (const entry of entries) {
		const expanded = await expandEntry(entry, sourceDir);
		if (expanded.length === 0) {
			const entryType = detectEntryType(entry);
			if (entryType === "directory") {
				logger.warn(`Directory not found or empty: ${entry}`);
			} else if (entryType === "glob") {
				logger.warn(`No files matched pattern: ${entry}`);
			}
		}
		allFiles.push(...expanded);
	}

	// Deduplicate files (in case of overlapping patterns)
	const uniqueFiles = [...new Set(allFiles)];

	return copyFiles(uniqueFiles, sourceDir, targetDir);
}

async function copyFiles(
	files: string[],
	sourceDir: string,
	targetDir: string,
): Promise<CopyResult[]> {
	const results: CopyResult[] = [];

	for (const file of files) {
		const sourcePath = join(sourceDir, file);
		const targetPath = join(targetDir, file);

		try {
			const sourceFile = Bun.file(sourcePath);
			if (!(await sourceFile.exists())) {
				logger.warn(`File not found: ${file}`);
				results.push({ file, success: false, error: "File not found" });
				continue;
			}

			const targetDirPath = dirname(targetPath);
			await mkdir(targetDirPath, { recursive: true });

			const content = await sourceFile.arrayBuffer();
			await Bun.write(targetPath, content);

			results.push({ file, success: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(`Failed to copy ${file}: ${message}`);
			results.push({ file, success: false, error: message });
		}
	}

	return results;
}

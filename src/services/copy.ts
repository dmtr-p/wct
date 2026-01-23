import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as logger from "../utils/logger";

export interface CopyResult {
	file: string;
	success: boolean;
	error?: string;
}

export async function copyFiles(
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

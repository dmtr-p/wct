import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedConfig, WctConfig } from "./schema";
import { resolveConfig, validateConfig } from "./validator";

const CONFIG_FILENAME = ".wct.yaml";

export function expandTilde(path: string): string {
	if (path.startsWith("~/")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}

export function slugifyBranch(branch: string): string {
	return branch.replace(/[^a-zA-Z0-9_-]/g, "-");
}

async function loadConfigFile(path: string): Promise<WctConfig | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return null;
	}

	const content = await file.text();
	const parsed = Bun.YAML.parse(content);
	return parsed as WctConfig;
}

function mergeConfigs(
	global: WctConfig | null,
	project: WctConfig | null,
): WctConfig {
	if (!global && !project) {
		return {};
	}
	if (!global) {
		return project as WctConfig;
	}
	if (!project) {
		return global;
	}

	return {
		...global,
		...project,
		copy: project.copy ?? global.copy,
		setup: project.setup ?? global.setup,
		ide: project.ide ?? global.ide,
		tmux: project.tmux
			? {
					...global.tmux,
					...project.tmux,
					panes: project.tmux.panes ?? global.tmux?.panes,
				}
			: global.tmux,
	};
}

export interface LoadConfigResult {
	config: ResolvedConfig | null;
	errors: string[];
	hasProjectConfig: boolean;
	hasGlobalConfig: boolean;
}

export async function loadConfig(
	projectDir: string,
): Promise<LoadConfigResult> {
	const projectConfigPath = join(projectDir, CONFIG_FILENAME);
	const globalConfigPath = join(homedir(), CONFIG_FILENAME);

	const [projectConfig, globalConfig] = await Promise.all([
		loadConfigFile(projectConfigPath),
		loadConfigFile(globalConfigPath),
	]);

	const hasProjectConfig = projectConfig !== null;
	const hasGlobalConfig = globalConfig !== null;

	if (!hasProjectConfig && !hasGlobalConfig) {
		return {
			config: null,
			errors: ["No config file found. Run 'wct init' to create one."],
			hasProjectConfig,
			hasGlobalConfig,
		};
	}

	const merged = mergeConfigs(globalConfig, projectConfig);
	const validation = validateConfig(merged);

	if (!validation.valid) {
		return {
			config: null,
			errors: validation.errors,
			hasProjectConfig,
			hasGlobalConfig,
		};
	}

	const resolved = resolveConfig(merged, projectDir);

	return {
		config: resolved,
		errors: [],
		hasProjectConfig,
		hasGlobalConfig,
	};
}

export function resolveWorktreePath(
	worktreeDir: string,
	branch: string,
	projectDir: string,
	projectName: string,
): string {
	const expanded = expandTilde(worktreeDir);
	const basePath = expanded.startsWith("/")
		? expanded
		: resolve(projectDir, expanded);
	return join(
		basePath,
		`${slugifyBranch(projectName)}-${slugifyBranch(branch)}`,
	);
}

export { CONFIG_FILENAME };

import type { ResolvedConfig, TabConfig } from "./schema";

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

export function validateConfig(config: unknown): ValidationResult {
	const errors: string[] = [];

	if (!config || typeof config !== "object") {
		return { valid: false, errors: ["Config must be an object"] };
	}

	const cfg = config as Record<string, unknown>;

	if (cfg.version !== undefined && typeof cfg.version !== "number") {
		errors.push("version must be a number");
	}

	if (cfg.worktree_dir !== undefined && typeof cfg.worktree_dir !== "string") {
		errors.push("worktree_dir must be a string");
	}

	if (cfg.project_name !== undefined && typeof cfg.project_name !== "string") {
		errors.push("project_name must be a string");
	}

	if (cfg.copy !== undefined) {
		if (!Array.isArray(cfg.copy)) {
			errors.push("copy must be an array");
		} else {
			for (let i = 0; i < cfg.copy.length; i++) {
				if (typeof cfg.copy[i] !== "string") {
					errors.push(`copy[${i}] must be a string`);
				}
			}
		}
	}

	if (cfg.setup !== undefined) {
		if (!Array.isArray(cfg.setup)) {
			errors.push("setup must be an array");
		} else {
			for (let i = 0; i < cfg.setup.length; i++) {
				const cmd = cfg.setup[i] as Record<string, unknown>;
				if (!cmd || typeof cmd !== "object") {
					errors.push(`setup[${i}] must be an object`);
					continue;
				}
				if (typeof cmd.name !== "string") {
					errors.push(`setup[${i}].name must be a string`);
				}
				if (typeof cmd.command !== "string") {
					errors.push(`setup[${i}].command must be a string`);
				}
				if (cmd.optional !== undefined && typeof cmd.optional !== "boolean") {
					errors.push(`setup[${i}].optional must be a boolean`);
				}
			}
		}
	}

	if (cfg.ide !== undefined) {
		if (!cfg.ide || typeof cfg.ide !== "object") {
			errors.push("ide must be an object");
		} else {
			const ide = cfg.ide as Record<string, unknown>;
			if (typeof ide.command !== "string") {
				errors.push("ide.command must be a string");
			}
		}
	}

	if (cfg.tmux !== undefined) {
		if (!cfg.tmux || typeof cfg.tmux !== "object") {
			errors.push("tmux must be an object");
		} else {
			const tmux = cfg.tmux as Record<string, unknown>;

			if (
				tmux.layout !== undefined &&
				tmux.layout !== "panes" &&
				tmux.layout !== "windows"
			) {
				errors.push('tmux.layout must be "panes" or "windows"');
			}

			if (
				tmux.split !== undefined &&
				tmux.split !== "horizontal" &&
				tmux.split !== "vertical"
			) {
				errors.push('tmux.split must be "horizontal" or "vertical"');
			}

			if (tmux.panes !== undefined) {
				if (!Array.isArray(tmux.panes)) {
					errors.push("tmux.panes must be an array");
				} else {
					for (let i = 0; i < tmux.panes.length; i++) {
						const pane = tmux.panes[i] as Record<string, unknown>;
						if (!pane || typeof pane !== "object") {
							errors.push(`tmux.panes[${i}] must be an object`);
							continue;
						}
						if (typeof pane.name !== "string") {
							errors.push(`tmux.panes[${i}].name must be a string`);
						}
						if (
							pane.command !== undefined &&
							typeof pane.command !== "string"
						) {
							errors.push(`tmux.panes[${i}].command must be a string`);
						}
					}
				}
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

export function resolveConfig(
	config: TabConfig,
	projectDir: string,
): ResolvedConfig {
	const projectName =
		config.project_name ??
		projectDir.split("/").filter(Boolean).pop() ??
		"project";
	const worktreeDir = config.worktree_dir ?? "../worktrees";

	return {
		...config,
		worktree_dir: worktreeDir,
		project_name: projectName,
	};
}

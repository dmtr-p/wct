import { type ResolvedConfig, VALID_LAYOUTS, type WctConfig } from "./schema";

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

      if (tmux.windows !== undefined) {
        if (!Array.isArray(tmux.windows)) {
          errors.push("tmux.windows must be an array");
        } else {
          for (let i = 0; i < tmux.windows.length; i++) {
            const win = tmux.windows[i] as Record<string, unknown>;
            if (!win || typeof win !== "object") {
              errors.push(`tmux.windows[${i}] must be an object`);
              continue;
            }
            if (typeof win.name !== "string") {
              errors.push(`tmux.windows[${i}].name must be a string`);
            } else if (/[:.#]/.test(win.name)) {
              errors.push(
                `tmux.windows[${i}].name contains invalid characters (: . #). These characters conflict with tmux target syntax.`,
              );
            }
            if (win.command !== undefined && typeof win.command !== "string") {
              errors.push(`tmux.windows[${i}].command must be a string`);
            }
            if (
              win.split !== undefined &&
              win.split !== "horizontal" &&
              win.split !== "vertical"
            ) {
              errors.push(
                `tmux.windows[${i}].split must be "horizontal" or "vertical"`,
              );
            }
            if (
              win.layout !== undefined &&
              !VALID_LAYOUTS.includes(
                win.layout as (typeof VALID_LAYOUTS)[number],
              )
            ) {
              errors.push(
                `tmux.windows[${i}].layout must be one of: ${VALID_LAYOUTS.join(", ")}`,
              );
            }
            if (win.panes !== undefined) {
              if (!Array.isArray(win.panes)) {
                errors.push(`tmux.windows[${i}].panes must be an array`);
              } else {
                for (let j = 0; j < win.panes.length; j++) {
                  const pane = win.panes[j] as Record<string, unknown>;
                  if (!pane || typeof pane !== "object") {
                    errors.push(
                      `tmux.windows[${i}].panes[${j}] must be an object`,
                    );
                    continue;
                  }
                  if (
                    pane.name !== undefined &&
                    typeof pane.name !== "string"
                  ) {
                    errors.push(
                      `tmux.windows[${i}].panes[${j}].name must be a string`,
                    );
                  }
                  if (
                    pane.command !== undefined &&
                    typeof pane.command !== "string"
                  ) {
                    errors.push(
                      `tmux.windows[${i}].panes[${j}].command must be a string`,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function resolveConfig(
  config: WctConfig,
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

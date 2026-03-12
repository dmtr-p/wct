import { Schema } from "effect";
import { type ResolvedConfig, type WctConfig, WctConfigSchema } from "./schema";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const StandardWctConfigSchema = Schema.toStandardSchemaV1(WctConfigSchema, {
  parseOptions: { errors: "all" },
});

function formatIssuePath(path?: ReadonlyArray<unknown>): string {
  if (!path || path.length === 0) {
    return "";
  }

  let rendered = "";

  for (const segment of path) {
    if (typeof segment === "number") {
      rendered += `[${segment}]`;
      continue;
    }

    if (
      typeof segment === "object" &&
      segment !== null &&
      "key" in segment &&
      typeof (segment as { key?: unknown }).key === "string"
    ) {
      const key = (segment as { key: string }).key;
      rendered += rendered ? `.${key}` : key;
      continue;
    }

    if (typeof segment === "string") {
      rendered += rendered ? `.${segment}` : segment;
    }
  }

  return rendered;
}

function formatSchemaIssues(config: unknown): string[] {
  const result = StandardWctConfigSchema["~standard"].validate(config) as
    | { value: unknown }
    | {
        issues: ReadonlyArray<{
          message: string;
          path?: ReadonlyArray<unknown>;
        }>;
      };
  if ("value" in result) {
    return [];
  }

  return result.issues.map((issue) => {
    const path = formatIssuePath(issue.path);
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

function validateTmuxWindowNames(config: WctConfig): string[] {
  const windows = config.tmux?.windows ?? [];
  const errors: string[] = [];

  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    if (!window) {
      continue;
    }

    if (/[:.#]/.test(window.name)) {
      errors.push(
        `tmux.windows[${i}].name contains invalid characters (: . #). These characters conflict with tmux target syntax.`,
      );
    }
  }

  return errors;
}

export function validateConfig(config: unknown): ValidationResult {
  const errors = formatSchemaIssues(config);
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const decoded = Schema.decodeUnknownSync(WctConfigSchema)(config);
  if (decoded.tmux?.windows) {
    errors.push(...validateTmuxWindowNames(decoded));
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

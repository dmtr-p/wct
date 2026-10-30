import { isAbsolute, win32 } from "node:path";
import { Schema } from "effect";
import type { StandardSchemaV1 } from "effect/StandardSchema";
import {
  type ResolvedConfig,
  type TmuxWindow,
  type WctConfig,
  WctConfigSchema,
} from "./schema";

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

function validateTmuxWindowNames(
  windows: ReadonlyArray<TmuxWindow>,
  path: string,
): string[] {
  const errors: string[] = [];
  const names = new Set<string>();

  for (const [i, window] of windows.entries()) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(window.name)) {
      errors.push(`${path}[${i}].name must match [A-Za-z][A-Za-z0-9_-]*.`);
    }
    if (names.has(window.name)) {
      errors.push(
        `${path}[${i}].name duplicates window name ${JSON.stringify(window.name)} within ${path}.`,
      );
    }
    names.add(window.name);
  }

  return errors;
}

function validateWorkDir(workDir: string | undefined, path: string): string[] {
  if (workDir === undefined) return [];
  if (isAbsolute(workDir) || win32.isAbsolute(workDir)) {
    return [`${path} must be a relative path.`];
  }
  return [];
}

export function validateConfig(config: unknown): ValidationResult {
  // Configuration schemas contain only synchronous checks.
  const result = StandardWctConfigSchema["~standard"].validate(
    config,
  ) as StandardSchemaV1.Result<WctConfig>;
  if (result.issues) {
    const errors = result.issues.map((issue) => {
      const path = formatIssuePath(issue.path);
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return { valid: false, errors };
  }

  const decoded = result.value;
  const errors: string[] = [];
  for (const key of ["base_branch", "push_remote"] as const) {
    const value = decoded[key];
    if (value !== undefined && value.trim() === "") {
      errors.push(`${key} must be a nonempty string.`);
    }
  }
  errors.push(...validateWorkDir(decoded.work_dir, "work_dir"));
  if (decoded.tmux?.windows) {
    errors.push(
      ...validateTmuxWindowNames(decoded.tmux.windows, "tmux.windows"),
    );
  }

  if (decoded.profiles) {
    for (const [profileName, profile] of Object.entries(decoded.profiles)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profileName)) {
        errors.push(
          `Profile name ${JSON.stringify(profileName)} must match [A-Za-z0-9][A-Za-z0-9._-]*.`,
        );
      }
      errors.push(
        ...validateWorkDir(
          profile.work_dir,
          `profiles.${profileName}.work_dir`,
        ),
      );
      if (profile.tmux?.windows) {
        errors.push(
          ...validateTmuxWindowNames(
            profile.tmux.windows,
            `profiles.${profileName}.tmux.windows`,
          ),
        );
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
  const workDir = config.work_dir ?? ".";

  return {
    ...config,
    worktree_dir: worktreeDir,
    work_dir: workDir,
    project_name: projectName,
  };
}

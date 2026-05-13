import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, FileSystem, Path } from "effect";
import { identity } from "effect/Function";
import { runBunPromise } from "../effect/runtime";
import type { Profile, ResolvedConfig, WctConfig } from "./schema";
import { resolveConfig, validateConfig } from "./validator";

const CONFIG_FILENAME = ".wct.yaml";

const DEFAULT_IDE_CONFIG = {
  command: "code $WCT_WORKTREE_DIR",
} satisfies NonNullable<WctConfig["ide"]>;

const DEFAULT_CONFIG: WctConfig = {
  worktree_dir: "..",
  tmux: { windows: [{ name: "main" }] },
};

export function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function slugifyBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]/g, "-");
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
          windows: project.tmux.windows ?? global.tmux?.windows,
        }
      : global.tmux,
    profiles: project.profiles ?? global.profiles,
  };
}

export interface LoadConfigResult {
  config: ResolvedConfig | null;
  errors: string[];
  hasProjectConfig: boolean;
  hasGlobalConfig: boolean;
}

interface LoadedConfigFile {
  exists: boolean;
  config: WctConfig | null;
  error?: string;
}

function loadConfigFileEffect(
  filePath: string,
): Effect.Effect<LoadedConfigFile, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* Effect.match(fs.exists(filePath), {
      onFailure: () => false,
      onSuccess: identity,
    });

    if (!exists) {
      return { exists: false, config: null };
    }

    const contentResult = yield* Effect.match(fs.readFileString(filePath), {
      onFailure: (error) => ({
        ok: false as const,
        message: `Failed to read ${filePath}: ${error.message}`,
      }),
      onSuccess: (content) => ({
        ok: true as const,
        content,
      }),
    });

    if (!contentResult.ok) {
      return {
        exists: true,
        config: null,
        error: contentResult.message,
      };
    }

    const parsedResult = yield* Effect.match(
      Effect.try({
        try: () => Bun.YAML.parse(contentResult.content),
        catch: (error) =>
          `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      }),
      {
        onFailure: (error) => ({
          ok: false as const,
          message: error,
        }),
        onSuccess: (config) => ({
          ok: true as const,
          config,
        }),
      },
    );

    if (!parsedResult.ok) {
      return {
        exists: true,
        config: null,
        error: parsedResult.message,
      };
    }

    return {
      exists: true,
      config: parsedResult.config as WctConfig,
    };
  });
}

export function loadConfigEffect(
  projectDir: string,
): Effect.Effect<LoadConfigResult, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const projectConfigPath = path.join(projectDir, CONFIG_FILENAME);
    const globalConfigPath = path.join(homedir(), CONFIG_FILENAME);

    const [projectConfig, globalConfig] = yield* Effect.all([
      loadConfigFileEffect(projectConfigPath),
      loadConfigFileEffect(globalConfigPath),
    ]);

    const hasProjectConfig = projectConfig.exists;
    const hasGlobalConfig = globalConfig.exists;
    const loadErrors = [projectConfig.error, globalConfig.error].filter(
      (error): error is string => typeof error === "string",
    );

    if (loadErrors.length > 0) {
      return {
        config: null,
        errors: loadErrors,
        hasProjectConfig,
        hasGlobalConfig,
      };
    }

    const merged =
      hasProjectConfig || hasGlobalConfig
        ? mergeConfigs(globalConfig.config, projectConfig.config)
        : DEFAULT_CONFIG;
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
  });
}

export async function loadConfig(
  projectDir: string,
): Promise<LoadConfigResult> {
  return await runBunPromise(loadConfigEffect(projectDir));
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

export interface ProfileResult {
  config: ResolvedConfig;
  profileName?: string;
}

function matchesGlob(branch: string, pattern: string): boolean {
  const glob = new Bun.Glob(pattern);
  return glob.match(branch);
}

function profileMatchesBranch(profile: Profile, branch: string): boolean {
  if (!profile.match) return false;
  const patterns = Array.isArray(profile.match)
    ? profile.match
    : [profile.match];
  return patterns.some((pattern) => matchesGlob(branch, pattern));
}

function applyProfile(
  config: ResolvedConfig,
  profile: Profile,
): ResolvedConfig {
  const { profiles: _, ...base } = config;
  return {
    ...base,
    setup: profile.setup ?? base.setup,
    ide: profile.ide ?? base.ide,
    tmux: profile.tmux ?? base.tmux,
    copy: profile.copy ?? base.copy,
  };
}

function stripProfiles(config: ResolvedConfig): ResolvedConfig {
  const { profiles: _, ...rest } = config;
  return rest;
}

export function resolveProfile(
  config: ResolvedConfig,
  branch: string,
  explicitProfile?: string,
): ProfileResult {
  if (explicitProfile === "") {
    return { config: stripProfiles(config) };
  }

  if (!config.profiles) {
    return { config: stripProfiles(config) };
  }

  if (explicitProfile) {
    const profile = config.profiles[explicitProfile];
    if (!profile) {
      throw new Error(
        `Profile '${explicitProfile}' not found. Available profiles: ${Object.keys(config.profiles).join(", ")}`,
      );
    }
    return {
      config: applyProfile(config, profile),
      profileName: explicitProfile,
    };
  }

  for (const [name, profile] of Object.entries(config.profiles)) {
    if (profileMatchesBranch(profile, branch)) {
      return { config: applyProfile(config, profile), profileName: name };
    }
  }

  return { config: stripProfiles(config) };
}

export { CONFIG_FILENAME, DEFAULT_CONFIG, DEFAULT_IDE_CONFIG };

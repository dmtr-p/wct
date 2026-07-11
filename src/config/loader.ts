import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Data, Effect, FileSystem } from "effect";
import { identity } from "effect/Function";
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

function homeDir(): string {
  return process.env.HOME ?? homedir();
}

export interface IdeLaunchOptions {
  ide?: boolean;
  noIde?: boolean;
}

export interface ResolvedIdeLaunch {
  open: boolean;
  command: string | undefined;
  config: WctConfig["ide"] | undefined;
}

export function resolveIdeLaunch(
  ideConfig: WctConfig["ide"] | undefined,
  options: IdeLaunchOptions,
): ResolvedIdeLaunch {
  const mergedConfig = ideConfig?.command
    ? ideConfig
    : ideConfig
      ? { ...DEFAULT_IDE_CONFIG, ...ideConfig }
      : undefined;

  if (options.noIde) {
    return {
      open: false,
      command: mergedConfig?.command,
      config: mergedConfig,
    };
  }

  if (options.ide) {
    const config = mergedConfig ?? DEFAULT_IDE_CONFIG;
    return {
      open: true,
      command: config.command,
      config,
    };
  }

  if (!mergedConfig) {
    return {
      open: false,
      command: undefined,
      config: undefined,
    };
  }

  const open = mergedConfig.open ?? true;
  return {
    open,
    command: mergedConfig.command,
    config: mergedConfig,
  };
}

export function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    return join(homeDir(), path.slice(2));
  }
  return path;
}

export function slugifyBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  details: string;
  cause?: unknown;
}> {
  override get message(): string {
    return this.details;
  }
}

function configError(details: string, cause?: unknown): ConfigError {
  return new ConfigError({ details, cause });
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
    ide: mergeIdeConfig(global.ide, project.ide),
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

function mergeIdeConfig(
  base: WctConfig["ide"] | undefined,
  override: WctConfig["ide"] | undefined,
): WctConfig["ide"] | undefined {
  if (!base) return override;
  if (!override) return base;
  return {
    ...base,
    ...override,
  };
}

interface LoadedConfigFile {
  exists: boolean;
  config: WctConfig | null;
}

type LoadConfigFileResult =
  | { ok: true; file: LoadedConfigFile }
  | { ok: false; error: ConfigError };

function loadConfigFileEffect(
  filePath: string,
): Effect.Effect<LoadedConfigFile, ConfigError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* Effect.match(fs.exists(filePath), {
      onFailure: () => false,
      onSuccess: identity,
    });

    if (!exists) {
      return { exists: false, config: null };
    }

    const content = yield* Effect.mapError(
      fs.readFileString(filePath),
      (error) =>
        configError(`Failed to read ${filePath}: ${error.message}`, error),
    );

    const parsed = yield* Effect.mapError(
      Effect.try({
        try: () => Bun.YAML.parse(content),
        catch: (error) => error,
      }),
      (error) =>
        configError(
          `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
          error,
        ),
    );

    return {
      exists: true,
      config: parsed as WctConfig,
    };
  });
}

function captureConfigFile(
  filePath: string,
): Effect.Effect<LoadConfigFileResult, never, FileSystem.FileSystem> {
  return Effect.match(loadConfigFileEffect(filePath), {
    onFailure: (error) => ({ ok: false, error }),
    onSuccess: (file) => ({ ok: true, file }),
  });
}

export function loadConfig(
  projectDir: string,
): Effect.Effect<ResolvedConfig, ConfigError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const projectConfigPath = join(projectDir, CONFIG_FILENAME);
    const globalConfigPath = join(homeDir(), CONFIG_FILENAME);

    const [projectResult, globalResult] = yield* Effect.all([
      captureConfigFile(projectConfigPath),
      captureConfigFile(globalConfigPath),
    ]);

    if (!projectResult.ok || !globalResult.ok) {
      const loadErrors = [projectResult, globalResult]
        .filter(
          (result): result is { ok: false; error: ConfigError } => !result.ok,
        )
        .map((result) => result.error.message);
      return yield* Effect.fail(configError(loadErrors.join("\n")));
    }

    const projectConfig = projectResult.file;
    const globalConfig = globalResult.file;

    const hasProjectConfig = projectConfig.exists;
    const hasGlobalConfig = globalConfig.exists;
    const merged =
      hasProjectConfig || hasGlobalConfig
        ? mergeConfigs(globalConfig.config, projectConfig.config)
        : DEFAULT_CONFIG;
    const validation = validateConfig(merged);

    if (!validation.valid) {
      return yield* Effect.fail(configError(validation.errors.join("\n")));
    }

    return resolveConfig(merged, projectDir);
  });
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
    work_dir: profile.work_dir ?? base.work_dir,
    setup: profile.setup ?? base.setup,
    ide: mergeIdeConfig(base.ide, profile.ide),
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

import { basename, resolve } from "node:path";
import { Effect, FileSystem } from "effect";
import { loadConfig } from "../config/loader";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { type RegistryItem, RegistryService } from "./registry-service";
import { WorktreeService } from "./worktree-service";

export interface RegisterProjectOptions {
  path?: string;
  name?: string;
  tolerateConfigErrors?: boolean;
}

export interface RegisterProjectResult {
  item: RegistryItem;
  repoPath: string;
  projectName: string;
}

function currentDirectory(): Effect.Effect<string, WctError> {
  return Effect.try({
    try: () => process.cwd(),
    catch: (error) =>
      commandError(
        "worktree_error",
        "Could not determine current directory",
        error,
      ),
  });
}

function resolveInputPath(path?: string): Effect.Effect<string, WctError> {
  return Effect.gen(function* () {
    const rawPath = path ?? (yield* currentDirectory());
    const resolvedPath = resolve(rawPath);

    const fs = yield* FileSystem.FileSystem;
    const exists = yield* Effect.mapError(fs.exists(resolvedPath), (error) =>
      commandError("invalid_options", `Invalid path: ${resolvedPath}`, error),
    );

    if (!exists) {
      return yield* Effect.fail(
        commandError("invalid_options", `Invalid path: ${resolvedPath}`),
      );
    }

    return resolvedPath;
  });
}

function deriveProjectName(
  repoPath: string,
  explicitName: string | undefined,
  tolerateConfigErrors: boolean,
): Effect.Effect<string, WctError> {
  return Effect.gen(function* () {
    if (explicitName !== undefined) {
      return explicitName;
    }

    const loadResult = yield* Effect.catch(
      Effect.tryPromise({
        try: () => loadConfig(repoPath),
        catch: (error) =>
          commandError("config_error", "Failed to load config", error),
      }),
      (error) =>
        tolerateConfigErrors ? Effect.succeed(null) : Effect.fail(error),
    );

    if (loadResult && !loadResult.config && !tolerateConfigErrors) {
      return yield* Effect.fail(
        commandError("config_error", loadResult.errors.join("\n")),
      );
    }

    return loadResult?.config?.project_name ?? basename(repoPath) ?? "unknown";
  });
}

export function registerProject(
  options: RegisterProjectOptions = {},
): Effect.Effect<RegisterProjectResult, WctError, WctServices> {
  return Effect.gen(function* () {
    const inputPath = yield* resolveInputPath(options.path);
    const repoPath = yield* WorktreeService.use((service) =>
      service.getMainRepoPath(inputPath),
    );

    if (!repoPath) {
      return yield* Effect.fail(
        commandError("not_git_repo", `Not a git repository: ${inputPath}`),
      );
    }

    const projectName = yield* deriveProjectName(
      repoPath,
      options.name,
      options.tolerateConfigErrors ?? false,
    );

    const item = yield* RegistryService.use((service) =>
      service.register(repoPath, projectName),
    );

    return {
      item,
      repoPath,
      projectName,
    };
  });
}

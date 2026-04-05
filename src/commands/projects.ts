import { basename, resolve } from "node:path";
import { Console, Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";
import { loadConfig } from "../config/loader";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { RegistryService } from "../services/registry-service";
import { WorktreeService } from "../services/worktree-service";
import { jsonSuccess } from "../utils/json-output";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "projects",
  description: "Manage the project registry",
  subcommands: [
    {
      name: "add",
      description: "Add a project to the registry",
      completionType: "path",
      options: [
        {
          name: "name",
          short: "n",
          type: "string",
          description: "Override project name",
        },
      ],
    },
    {
      name: "remove",
      description: "Remove a project from the registry",
      completionType: "path",
    },
    {
      name: "list",
      description: "List registered projects",
    },
  ],
};

function changeDirectory(path: string): Effect.Effect<void, WctError> {
  return Effect.try({
    try: () => {
      process.chdir(path);
    },
    catch: (error) =>
      commandError("invalid_options", `Invalid path: ${path}`, error),
  });
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

export function projectsAddCommand(opts?: {
  path?: string;
  name?: string;
}): Effect.Effect<
  void,
  WctError,
  WctServices | "effect/unstable/cli/GlobalFlag/json"
> {
  return Effect.gen(function* () {
    const json = yield* JsonFlag;
    const originalCwd = yield* currentDirectory();
    const repoPath = resolve(opts?.path ?? originalCwd);
    if (opts?.path) {
      yield* changeDirectory(repoPath);
    }

    const mainDir = yield* Effect.ensuring(
      Effect.catch(
        WorktreeService.use((service) => service.getMainRepoPath()),
        () => Effect.succeed(null),
      ),
      opts?.path ? changeDirectory(originalCwd) : Effect.void,
    );

    if (!mainDir) {
      return yield* Effect.fail(
        commandError("not_git_repo", `Not a git repository: ${repoPath}`),
      );
    }

    let projectName = opts?.name ?? basename(mainDir) ?? "unknown";
    if (!opts?.name) {
      const loadResult = yield* Effect.catch(
        Effect.tryPromise({
          try: () => loadConfig(mainDir),
          catch: () => commandError("config_error", "Failed to load config"),
        }),
        () => Effect.succeed(null),
      );
      if (loadResult?.config?.project_name) {
        projectName = loadResult.config.project_name;
      }
    }

    const item = yield* RegistryService.use((service) =>
      service.register(mainDir, projectName),
    );

    if (json) {
      yield* jsonSuccess(item);
      return;
    }
    yield* logger.success(`Added ${mainDir} as '${projectName}'`);
  });
}

export function projectsRemoveCommand(
  path?: string,
): Effect.Effect<
  void,
  WctError,
  WctServices | "effect/unstable/cli/GlobalFlag/json"
> {
  return Effect.gen(function* () {
    const json = yield* JsonFlag;
    const originalCwd = yield* currentDirectory();
    const repoPath = resolve(path ?? originalCwd);
    if (path) {
      yield* changeDirectory(repoPath);
    }

    const mainDir = yield* Effect.ensuring(
      Effect.catch(
        WorktreeService.use((service) => service.getMainRepoPath()),
        () => Effect.succeed(null),
      ),
      path ? changeDirectory(originalCwd) : Effect.void,
    );

    const targetPath = mainDir ?? repoPath;

    const removed = yield* RegistryService.use((service) =>
      service.unregister(targetPath),
    );

    if (!removed) {
      return yield* Effect.fail(
        commandError(
          "registry_error",
          `Project not found in registry: ${targetPath}`,
        ),
      );
    }

    if (json) {
      yield* jsonSuccess({ repo_path: targetPath, removed: true });
      return;
    }
    yield* logger.success(`Removed ${targetPath}`);
  });
}

export function projectsListCommand(): Effect.Effect<
  void,
  WctError,
  WctServices | "effect/unstable/cli/GlobalFlag/json"
> {
  return Effect.gen(function* () {
    const json = yield* JsonFlag;
    const repos = yield* RegistryService.use((service) => service.listRepos());

    if (json) {
      yield* jsonSuccess(repos);
      return;
    }

    if (repos.length === 0) {
      yield* logger.info("No projects registered");
      return;
    }

    const headers = ["PROJECT", "PATH"] as const;
    const colWidths = [
      Math.max(headers[0].length, ...repos.map((r) => r.project.length)),
      Math.max(headers[1].length, ...repos.map((r) => r.repo_path.length)),
    ] as const;

    yield* Console.log(
      logger.bold(
        headers.map((h, i) => h.padEnd(colWidths[i] as number)).join("  "),
      ),
    );

    for (const repo of repos) {
      yield* Console.log(
        [
          repo.project.padEnd(colWidths[0]),
          repo.repo_path.padEnd(colWidths[1]),
        ].join("  "),
      );
    }
  });
}

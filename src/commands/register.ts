import { resolve } from "node:path";
import { Effect } from "effect";
import { loadConfig } from "../config/loader";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { RegistryService } from "../services/registry-service";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "register",
  description: "Register a repo in the TUI registry",
};

export function registerCommand(
  path?: string,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const repoPath = resolve(path ?? process.cwd());
    const originalCwd = process.cwd();
    if (path) process.chdir(repoPath);

    const { isRepo, mainDir } = yield* Effect.ensuring(
      Effect.gen(function* () {
        const isRepo = yield* WorktreeService.use((service) =>
          service.isGitRepo(),
        );
        const mainDir = isRepo
          ? yield* WorktreeService.use((service) => service.getMainRepoPath())
          : null;
        return { isRepo, mainDir };
      }),
      Effect.sync(() => {
        if (path) process.chdir(originalCwd);
      }),
    );

    if (!isRepo) {
      return yield* Effect.fail(
        commandError("not_git_repo", `Not a git repository: ${repoPath}`),
      );
    }
    if (!mainDir) {
      return yield* Effect.fail(
        commandError("worktree_error", "Could not determine repository root"),
      );
    }

    // Try to detect project name from config
    let projectName = mainDir.split("/").pop() ?? "unknown";
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

    yield* RegistryService.use((service) =>
      service.register(mainDir, projectName),
    );

    yield* logger.success(`Registered ${mainDir} as '${projectName}'`);
  });
}

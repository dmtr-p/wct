import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { RegistryService } from "../services/registry-service";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "unregister",
  description: "Remove a repo from the TUI registry",
};

export function unregisterCommand(
  path?: string,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const repoPath = path ?? process.cwd();

    const mainDir = yield* WorktreeService.use((service) =>
      service.getMainRepoPath(),
    );

    const targetPath = mainDir ?? repoPath;

    const removed = yield* RegistryService.use((service) =>
      service.unregister(targetPath),
    );

    if (!removed) {
      return yield* Effect.fail(
        commandError(
          "registry_error",
          `Repo not found in registry: ${targetPath}`,
        ),
      );
    }

    yield* logger.success(`Unregistered ${targetPath}`);
  });
}

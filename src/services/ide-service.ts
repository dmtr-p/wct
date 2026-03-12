import { Effect, ServiceMap } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import type { WctEnv } from "../types/env";
import { execShell, getProcessErrorMessage } from "./process";

export function substituteEnvVars(command: string, env: WctEnv): string {
  return command
    .replace(/\$WCT_WORKTREE_DIR/g, env.WCT_WORKTREE_DIR)
    .replace(/\$WCT_MAIN_DIR/g, env.WCT_MAIN_DIR)
    .replace(/\$WCT_BRANCH/g, env.WCT_BRANCH)
    .replace(/\$WCT_PROJECT/g, env.WCT_PROJECT)
    .replace(/\$\{WCT_WORKTREE_DIR\}/g, env.WCT_WORKTREE_DIR)
    .replace(/\$\{WCT_MAIN_DIR\}/g, env.WCT_MAIN_DIR)
    .replace(/\$\{WCT_BRANCH\}/g, env.WCT_BRANCH)
    .replace(/\$\{WCT_PROJECT\}/g, env.WCT_PROJECT);
}

export interface IdeService {
  openIDE: (
    command: string,
    env: WctEnv,
  ) => Effect.Effect<void, WctError, WctServices>;
}

export const IdeService = ServiceMap.Service<IdeService>("wct/IdeService");

export const liveIdeService: IdeService = IdeService.of({
  openIDE: (command, env) =>
    Effect.mapError(
      execShell(substituteEnvVars(command, env)).pipe(Effect.asVoid),
      (error) =>
        commandError(
          "unexpected_error",
          `Failed to open IDE: ${getProcessErrorMessage(error)}`,
          error,
        ),
    ),
});

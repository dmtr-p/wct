import { Effect, ServiceMap } from "effect";
import type { SetupCommand } from "../config/schema";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import type { WctEnv } from "../types/env";
import * as logger from "../utils/logger";
import { execShell, getProcessErrorMessage } from "./process";

export interface SetupResult {
  name: string;
  _tag: "Succeeded" | "OptionalFailed" | "Failed";
  error?: string;
}

export interface SetupService {
  runSetupCommands: (
    commands: ReadonlyArray<SetupCommand>,
    workingDir: string,
    env: WctEnv,
  ) => Effect.Effect<SetupResult[], WctError, WctServices>;
}

export const SetupService =
  ServiceMap.Service<SetupService>("wct/SetupService");

export const liveSetupService: SetupService = SetupService.of({
  runSetupCommands: (commands, workingDir, env) =>
    Effect.gen(function* () {
      const results: SetupResult[] = [];
      const totalSteps = commands.length;
      const fullEnv = {
        ...process.env,
        ...env,
      };

      for (let i = 0; i < commands.length; i++) {
        // biome-ignore lint/style/noNonNullAssertion: index is bounded by loop condition
        const cmd = commands[i]!;
        yield* logger.step(i + 1, totalSteps, cmd.name);

        try {
          yield* execShell(cmd.command, {
            cwd: workingDir,
            env: fullEnv,
            extendEnv: false,
          });

          results.push({ name: cmd.name, _tag: "Succeeded" });
        } catch (error) {
          const message = getProcessErrorMessage(error);

          if (cmd.optional) {
            yield* logger.warn(`${cmd.name} failed (optional): ${message}`);
            results.push({
              name: cmd.name,
              _tag: "OptionalFailed",
              error: message,
            });
          } else {
            yield* logger.error(`${cmd.name} failed: ${message}`);
            results.push({ name: cmd.name, _tag: "Failed", error: message });
          }
        }
      }

      return results;
    }).pipe(
      Effect.mapError((error) =>
        commandError("unexpected_error", "Failed to run setup commands", error),
      ),
    ),
});

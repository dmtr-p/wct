import type { BunServices } from "@effect/platform-bun";
import { Context, Effect } from "effect";
import type { SetupCommand } from "../config/schema";
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
    /**
     * Optional per-command-start hook, invoked with the command's configured
     * NAME (never its shell text) immediately before it runs, so callers learn
     * setup progress in execution order. Typed `Effect.Effect<void>` — it can
     * neither fail nor require services — so a progress reporter can never
     * fail setup; the only supplier is `emitReporter` in `workspace-service`,
     * which already swallows reporter failures.
     */
    onCommandStart?: (name: string) => Effect.Effect<void>,
  ) => Effect.Effect<SetupResult[], WctError, BunServices.BunServices>;
}

export const SetupService = Context.Service<SetupService>("wct/SetupService");

export const liveSetupService: SetupService = SetupService.of({
  runSetupCommands: (commands, workingDir, env, onCommandStart) =>
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
        if (onCommandStart) yield* onCommandStart(cmd.name);
        yield* logger.step(i + 1, totalSteps, cmd.name);

        const step = execShell(cmd.command, {
          cwd: workingDir,
          env: fullEnv,
          extendEnv: false,
        }).pipe(
          Effect.as<SetupResult>({
            name: cmd.name,
            _tag: "Succeeded",
          }),
        );
        const result: SetupResult = yield* Effect.catch(step, (error) => {
          const message = getProcessErrorMessage(error);

          if (cmd.optional) {
            return logger
              .warn(`${cmd.name} failed (optional): ${message}`)
              .pipe(
                Effect.as<SetupResult>({
                  name: cmd.name,
                  _tag: "OptionalFailed",
                  error: message,
                }),
              );
          }

          return logger.error(`${cmd.name} failed: ${message}`).pipe(
            Effect.as<SetupResult>({
              name: cmd.name,
              _tag: "Failed",
              error: message,
            }),
          );
        });

        results.push(result);
      }

      return results;
    }).pipe(
      Effect.mapError((error) =>
        commandError("unexpected_error", "Failed to run setup commands", error),
      ),
    ),
});

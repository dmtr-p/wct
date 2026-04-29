import { Context, Effect } from "effect";
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

export const SetupService = Context.Service<SetupService>("wct/SetupService");

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

import type { BunServices } from "@effect/platform-bun";
import { Context, Effect } from "effect";
import type { SetupCommand } from "../config/schema";
import { commandError, type WctError } from "../errors";
import type { WctEnv } from "../types/env";
import { execShell, getProcessErrorMessage } from "./process";

export interface SetupResult {
  name: string;
  _tag: "Succeeded" | "OptionalFailed" | "Failed";
  error?: string;
}

export interface SetupReporter {
  commandStarted: (
    name: string,
    current: number,
    total: number,
  ) => Effect.Effect<void>;
  commandCompleted: (result: SetupResult) => Effect.Effect<void>;
}

export interface SetupService {
  runSetupCommands: (
    commands: ReadonlyArray<SetupCommand>,
    workingDir: string,
    env: WctEnv,
    reporter?: SetupReporter,
  ) => Effect.Effect<SetupResult[], WctError, BunServices.BunServices>;
}

export const SetupService = Context.Service<SetupService>("wct/SetupService");

export const liveSetupService: SetupService = SetupService.of({
  runSetupCommands: (commands, workingDir, env, reporter) =>
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
        if (reporter) {
          yield* reporter.commandStarted(cmd.name, i + 1, totalSteps);
        }

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
            return Effect.succeed<SetupResult>({
              name: cmd.name,
              _tag: "OptionalFailed",
              error: message,
            });
          }

          return Effect.succeed<SetupResult>({
            name: cmd.name,
            _tag: "Failed",
            error: message,
          });
        });

        if (reporter) {
          yield* reporter.commandCompleted(result);
        }

        results.push(result);
      }

      return results;
    }).pipe(
      Effect.mapError((error) =>
        commandError("unexpected_error", "Failed to run setup commands", error),
      ),
    ),
});

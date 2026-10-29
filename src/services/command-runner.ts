import type { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import type { SetupCommand } from "../config/schema";
import type { WctEnv } from "../types/env";
import {
  execShell,
  getProcessErrorMessage,
  processEnvironment,
} from "./process";

export interface CommandResult {
  name: string;
  _tag: "Succeeded" | "OptionalFailed" | "Failed";
  error?: string;
}

export interface CommandReporter {
  commandStarted: (
    name: string,
    current: number,
    total: number,
  ) => Effect.Effect<void>;
  commandCompleted: (result: CommandResult) => Effect.Effect<void>;
}

export function runShellCommands(
  commands: ReadonlyArray<SetupCommand>,
  workingDir: string,
  env: WctEnv,
  reporter?: CommandReporter,
): Effect.Effect<CommandResult[], never, BunServices.BunServices> {
  return Effect.gen(function* () {
    const results: CommandResult[] = [];
    const fullEnv = { ...(yield* processEnvironment), ...env };

    for (const [index, command] of commands.entries()) {
      if (reporter) {
        yield* reporter.commandStarted(
          command.name,
          index + 1,
          commands.length,
        );
      }
      const result = yield* Effect.match(
        execShell(command.command, {
          cwd: workingDir,
          env: fullEnv,
          extendEnv: false,
        }),
        {
          onSuccess: (): CommandResult => ({
            name: command.name,
            _tag: "Succeeded",
          }),
          onFailure: (error): CommandResult => ({
            name: command.name,
            _tag: command.optional ? "OptionalFailed" : "Failed",
            error: getProcessErrorMessage(error),
          }),
        },
      );
      results.push(result);
      if (reporter) {
        yield* reporter.commandCompleted(result);
      }
    }
    return results;
  });
}

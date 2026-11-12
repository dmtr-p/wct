import type { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import type { SetupCommand } from "../config/schema";
import { WctCommandError, type WctError } from "../errors";
import type { WctEnv } from "../types/env";
import {
  execShell,
  getProcessErrorMessage,
  processEnvironment,
} from "./process";

export type CommandResult =
  | { _tag: "Succeeded"; name: string }
  | { _tag: "OptionalFailed"; name: string; error: string }
  | { _tag: "Failed"; name: string; error: string };

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
): Effect.Effect<CommandResult[], WctError, BunServices.BunServices> {
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
      const result = yield* Effect.matchEffect(
        execShell(command.command, {
          cwd: workingDir,
          env: fullEnv,
          extendEnv: false,
        }),
        {
          onSuccess: () =>
            Effect.succeed<CommandResult>({
              name: command.name,
              _tag: "Succeeded",
            }),
          onFailure: (error) =>
            error instanceof WctCommandError &&
            error.code === "workspace_coordination_error"
              ? Effect.fail(error)
              : Effect.succeed<CommandResult>({
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

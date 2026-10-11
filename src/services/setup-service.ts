import type { BunServices } from "@effect/platform-bun";
import { Context, type Effect } from "effect";
import type { SetupCommand } from "../config/schema";
import type { WctError } from "../errors";
import type { WctEnv } from "../types/env";
import {
  type CommandReporter,
  type CommandResult,
  runShellCommands,
} from "./command-runner";

export type SetupResult = CommandResult;
export type SetupReporter = CommandReporter;

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
  runSetupCommands: runShellCommands,
});

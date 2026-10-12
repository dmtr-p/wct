import type { BunServices } from "@effect/platform-bun";
import { Context, type Effect } from "effect";
import type { SetupCommand } from "../config/schema";
import {
  captureBunService,
  type ServiceImplementation,
} from "../effect/service-context";
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
  ) => Effect.Effect<SetupResult[], WctError>;
}

export const SetupService = Context.Service<SetupService>("wct/SetupService");

export type SetupServiceImplementation = ServiceImplementation<
  SetupService,
  BunServices.BunServices
>;

export const liveSetupService: SetupServiceImplementation = {
  runSetupCommands: runShellCommands,
};

export function makeSetupService(
  implementation: SetupServiceImplementation = liveSetupService,
) {
  return captureBunService<SetupService>(implementation);
}

import { $ } from "bun";
import type { SetupCommand } from "../config/schema";
import type { WctEnv } from "../types/env";
import * as logger from "../utils/logger";

export interface SetupResult {
  name: string;
  success: boolean;
  error?: string;
}

export async function runSetupCommands(
  commands: SetupCommand[],
  workingDir: string,
  env: WctEnv,
): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  const totalSteps = commands.length;

  const fullEnv = {
    ...process.env,
    ...env,
  };

  for (let i = 0; i < commands.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index is bounded by loop condition
    const cmd = commands[i]!;
    logger.step(i + 1, totalSteps, cmd.name);

    try {
      await $`sh -c ${cmd.command}`.cwd(workingDir).env(fullEnv).quiet();

      results.push({ name: cmd.name, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (cmd.optional) {
        logger.warn(`${cmd.name} failed (optional): ${message}`);
        results.push({ name: cmd.name, success: false, error: message });
      } else {
        logger.error(`${cmd.name} failed: ${message}`);
        results.push({ name: cmd.name, success: false, error: message });
      }
    }
  }

  return results;
}

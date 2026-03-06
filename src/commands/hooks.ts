import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveWctBin } from "../utils/bin";
import * as logger from "../utils/logger";
import { type CommandResult, ok } from "../utils/result";
import type { CommandDef } from "./registry";

export const commandDef: CommandDef = {
  name: "hooks",
  description: "Output or install Claude Code hooks config",
  options: [
    {
      name: "install",
      type: "boolean",
      description: "Install hooks into .claude/settings.local.json",
    },
  ],
};

function buildHooksConfig() {
  const bin = resolveWctBin();
  return {
    hooks: {
      Notification: [
        {
          matcher: "permission_prompt",
          hooks: [{ type: "command", command: `${bin} notify`, async: true }],
        },
        {
          matcher: "idle_prompt",
          hooks: [{ type: "command", command: `${bin} notify`, async: true }],
        },
      ],
    },
  };
}

export interface HooksOptions {
  install?: boolean;
}

export async function hooksCommand(
  options: HooksOptions,
): Promise<CommandResult> {
  if (!options.install) {
    // Print JSON to stdout, usage to stderr
    console.log(JSON.stringify(buildHooksConfig(), null, 2));
    console.error(
      "\nAdd this to your .claude/settings.local.json, or run: wct hooks --install",
    );
    return ok();
  }

  const settingsPath = join(process.cwd(), ".claude", "settings.local.json");
  const file = Bun.file(settingsPath);

  let settings: Record<string, unknown> = {};
  if (await file.exists()) {
    try {
      settings = JSON.parse(await file.text());
    } catch {
      logger.warn("Could not parse existing settings file, creating new one");
    }

    if (
      settings.hooks &&
      typeof settings.hooks === "object" &&
      "Notification" in (settings.hooks as Record<string, unknown>)
    ) {
      logger.warn("Notification hooks already configured in settings");
      return ok();
    }
  }

  // Merge hooks into settings
  const existingHooks =
    settings.hooks && typeof settings.hooks === "object"
      ? (settings.hooks as Record<string, unknown>)
      : {};

  settings.hooks = {
    ...existingHooks,
    ...buildHooksConfig().hooks,
  };

  // Ensure .claude directory exists
  mkdirSync(join(process.cwd(), ".claude"), { recursive: true });

  await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
  logger.success(`Installed hooks config to ${settingsPath}`);

  return ok();
}

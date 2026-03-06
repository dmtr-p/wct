import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatShellCommand, resolveWctBin } from "../utils/bin";
import * as logger from "../utils/logger";
import { type CommandResult, err, ok } from "../utils/result";
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
  const notifyCommand = formatShellCommand(bin, ["notify"]);
  return {
    hooks: {
      Notification: [
        {
          matcher: "permission_prompt",
          hooks: [{ type: "command", command: notifyCommand, async: true }],
        },
        {
          matcher: "idle_prompt",
          hooks: [{ type: "command", command: notifyCommand, async: true }],
        },
      ],
    },
  };
}

function hasWctNotifyHookForMatcher(
  hooks: unknown[],
  matcher: string,
  notifyCommand: string,
): boolean {
  return hooks.some((hook) => {
    if (
      typeof hook !== "object" ||
      hook === null ||
      !("matcher" in hook) ||
      (hook as { matcher?: unknown }).matcher !== matcher ||
      !("hooks" in hook)
    ) {
      return false;
    }

    const nestedHooks = (hook as { hooks?: unknown }).hooks;
    if (!Array.isArray(nestedHooks)) {
      return false;
    }

    return nestedHooks.some(
      (nestedHook) =>
        typeof nestedHook === "object" &&
        nestedHook !== null &&
        "type" in nestedHook &&
        "command" in nestedHook &&
        (nestedHook as { type?: unknown }).type === "command" &&
        (nestedHook as { command?: unknown }).command === notifyCommand,
    );
  });
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
  }

  // Merge hooks into settings
  const existingHooks =
    settings.hooks && typeof settings.hooks === "object"
      ? (settings.hooks as Record<string, unknown>)
      : {};
  const notificationConfig = buildHooksConfig().hooks.Notification;
  const notifyCommand = notificationConfig[0]?.hooks[0]?.command ?? "";
  const notificationHooks = Array.isArray(existingHooks.Notification)
    ? existingHooks.Notification
    : [];
  const newNotificationHooks = notificationConfig.filter(
    (hook) =>
      !hasWctNotifyHookForMatcher(
        notificationHooks,
        hook.matcher,
        notifyCommand,
      ),
  );

  settings.hooks = {
    ...existingHooks,
    Notification: [...notificationHooks, ...newNotificationHooks],
  };

  try {
    mkdirSync(join(process.cwd(), ".claude"), { recursive: true });
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
    logger.success(`Installed hooks config to ${settingsPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to install hooks config: ${message}`);
    return err(`Failed to install hooks config: ${message}`, "config_error");
  }

  return ok();
}

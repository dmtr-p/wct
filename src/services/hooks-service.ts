import { join } from "node:path";
import { Effect, ServiceMap } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { formatShellCommand, resolveWctBin } from "../utils/bin";
import * as logger from "../utils/logger";
import { ensureDirectory, pathExists, readText, writeText } from "./filesystem";

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

export interface HooksService {
  renderHooksConfig: () => Effect.Effect<string, WctError, WctServices>;
  installHooks: (cwd: string) => Effect.Effect<void, WctError, WctServices>;
}

export const HooksService =
  ServiceMap.Service<HooksService>("wct/HooksService");

export const liveHooksService: HooksService = HooksService.of({
  renderHooksConfig: () =>
    Effect.sync(() => JSON.stringify(buildHooksConfig(), null, 2)),
  installHooks: (cwd) =>
    Effect.gen(function* () {
      const settingsPath = join(cwd, ".claude", "settings.local.json");

      let settings: Record<string, unknown> = {};
      if (yield* pathExists(settingsPath)) {
        try {
          settings = JSON.parse(yield* readText(settingsPath));
        } catch {
          yield* logger.warn(
            "Could not parse existing settings file, creating new one",
          );
        }
      }

      const existingHooks =
        settings.hooks && typeof settings.hooks === "object"
          ? (settings.hooks as Record<string, unknown>)
          : {};
      const notificationConfig = buildHooksConfig().hooks.Notification;
      const notifyCommand = notificationConfig[0]?.hooks[0]?.command;
      if (!notifyCommand) {
        return yield* Effect.fail(
          commandError("config_error", "Failed to build notify hook command"),
        );
      }

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

      yield* ensureDirectory(join(cwd, ".claude"));
      yield* writeText(settingsPath, JSON.stringify(settings, null, 2));
      yield* logger.success(`Installed hooks config to ${settingsPath}`);
    }).pipe(
      Effect.mapError((error) =>
        commandError("config_error", "Failed to install hooks config", error),
      ),
    ),
});

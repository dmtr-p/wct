import { $ } from "bun";
import { addItem } from "../services/queue";
import { formatSessionName, isMissingPaneError } from "../services/tmux";
import * as logger from "../utils/logger";
import { type CommandResult, ok } from "../utils/result";
import type { CommandDef } from "./registry";

export const commandDef: CommandDef = {
  name: "notify",
  description: "Queue a notification from Claude Code hooks",
};

export function isPaneCurrentlyVisible(output: string): boolean {
  const [paneActive, windowVisible, attachedCountRaw] = output.split(":");
  const attachedCount = Number.parseInt(attachedCountRaw ?? "0", 10);
  return (
    paneActive === "1" &&
    windowVisible === "1" &&
    (Number.isNaN(attachedCount) ? 0 : attachedCount) > 0
  );
}

export async function notifyCommand(): Promise<CommandResult> {
  const tmuxPane = process.env.TMUX_PANE;
  const branch = process.env.WCT_BRANCH;
  const project = process.env.WCT_PROJECT;

  if (!tmuxPane || !branch || !project) {
    return ok();
  }

  try {
    const stdin = await Bun.stdin.text();
    const data = JSON.parse(stdin);

    // Check if user is viewing this pane
    try {
      const result =
        await $`tmux display-message -p -t ${tmuxPane} '#{pane_active}:#{window_visible}:#{session_attached}'`.quiet();
      const output = result.text().trim();
      if (isPaneCurrentlyVisible(output)) {
        return ok();
      }
    } catch (error) {
      if (isMissingPaneError(error)) {
        return ok();
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Failed to inspect tmux pane '${tmuxPane}' for queued notification: ${message}`,
      );
    }

    // Get session name
    let session = formatSessionName(`${project}-${branch}`);
    try {
      const result =
        await $`tmux display-message -p -t ${tmuxPane} '#{session_name}'`.quiet();
      session = result.text().trim();
    } catch (error) {
      if (isMissingPaneError(error)) {
        return ok();
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Failed to resolve tmux session for pane '${tmuxPane}', using fallback '${session}': ${message}`,
      );
    }

    try {
      addItem({
        branch,
        project,
        type: data.notification_type ?? data.type ?? "unknown",
        message: data.message ?? data.title ?? "",
        session,
        pane: tmuxPane,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Failed to queue notification for branch='${branch}' project='${project}' session='${session}' pane='${tmuxPane}': ${message}`,
      );
      return ok();
    }

    // Refresh status bars
    try {
      await $`tmux refresh-client -S`.quiet();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Failed to refresh tmux status after queueing notification session='${session}' pane='${tmuxPane}': ${message}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Failed to process notification for branch='${branch}' project='${project}' pane='${tmuxPane}': ${message}`,
    );
  }

  return ok();
}

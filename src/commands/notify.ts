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

    // Check pane visibility and get session name in one tmux call
    let session = formatSessionName(`${project}-${branch}`);
    try {
      const result =
        await $`tmux display-message -p -t ${tmuxPane} '#{pane_active}:#{window_visible}:#{session_attached}:#{session_name}'`.quiet();
      const output = result.text().trim();
      const lastColon = output.lastIndexOf(":");
      const visibilityPart = output.slice(0, lastColon);
      const sessionName = output.slice(lastColon + 1);
      if (isPaneCurrentlyVisible(visibilityPart)) {
        return ok();
      }
      if (sessionName) {
        session = sessionName;
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

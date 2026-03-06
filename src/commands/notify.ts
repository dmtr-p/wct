import { $ } from "bun";
import { addItem } from "../services/queue";
import { type CommandResult, ok } from "../utils/result";
import type { CommandDef } from "./registry";

export const commandDef: CommandDef = {
  name: "notify",
  description: "Queue a notification from Claude Code hooks",
};

export async function notifyCommand(): Promise<CommandResult> {
  try {
    const stdin = await Bun.stdin.text();
    const data = JSON.parse(stdin);

    const tmuxPane = process.env.TMUX_PANE;
    const branch = process.env.WCT_BRANCH;
    const project = process.env.WCT_PROJECT;

    if (!tmuxPane || !branch || !project) {
      return ok();
    }

    // Check if user is viewing this pane
    try {
      const result =
        await $`tmux display-message -p -t ${tmuxPane} '#{pane_active}:#{session_attached}'`.quiet();
      const output = result.text().trim();
      if (output === "1:1") {
        return ok();
      }
    } catch {
      // pane might not exist, skip
      return ok();
    }

    // Get session name
    let session: string;
    try {
      const result =
        await $`tmux display-message -p -t ${tmuxPane} '#{session_name}'`.quiet();
      session = result.text().trim();
    } catch {
      return ok();
    }

    await addItem({
      branch,
      project,
      type: data.notification_type ?? data.type ?? "unknown",
      message: data.message ?? data.title ?? "",
      session,
      pane: tmuxPane,
    });

    // Refresh status bars
    try {
      await $`tmux refresh-client -S`.quiet();
    } catch {
      // ignore
    }
  } catch {
    // Never fail loudly
  }

  return ok();
}

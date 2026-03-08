import { createInterface } from "node:readline";
import { $ } from "bun";
import type { QueueItem } from "../services/queue";
import {
  clearAll,
  formatCount,
  listItems,
  removeItem,
} from "../services/queue";
import * as logger from "../utils/logger";
import { type CommandResult, err, ok } from "../utils/result";
import type { CommandDef } from "./registry";

export const commandDef: CommandDef = {
  name: "queue",
  description: "Manage the agent notification queue",
  options: [
    {
      name: "count",
      type: "boolean",
      description: "Output count for tmux status bar",
    },
    {
      name: "interactive",
      short: "i",
      type: "boolean",
      description: "Interactive mode for tmux popup",
    },
    {
      name: "jump",
      type: "string",
      placeholder: "id",
      description: "Jump to item's tmux session/pane",
    },
    {
      name: "dismiss",
      type: "string",
      placeholder: "id",
      description: "Remove item from queue",
    },
    {
      name: "clear",
      type: "boolean",
      description: "Clear all queue items",
    },
  ],
};

export interface QueueOptions {
  count?: boolean;
  interactive?: boolean;
  jump?: string;
  dismiss?: string;
  clear?: boolean;
}

function formatType(type: string): string {
  if (type === "permission_prompt") return "permission";
  if (type === "idle_prompt") return "question";
  return type;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}\u2026`;
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export const queueInternals = {
  async jumpToItem(item: QueueItem): Promise<boolean> {
    try {
      await $`tmux switch-client -t =${item.session}`.quiet();
      await $`tmux select-pane -t ${item.pane}`.quiet();
      removeItem(item.id);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Failed to jump to queue item session='${item.session}' pane='${item.pane}': ${message}`,
      );
      return false;
    }
  },
};

async function interactiveMode(): Promise<CommandResult> {
  const items = await listItems();

  if (items.length === 0) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await new Promise<void>((resolve) => {
      rl.question(
        "\n  No pending notifications. Press enter to close.\n",
        () => {
          rl.close();
          resolve();
        },
      );
    });
    return ok();
  }

  const render = () => {
    console.log("\n  Agent Queue\n");
    for (let i = 0; i < items.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: index is bounded by loop condition
      const item = items[i]!;
      const num = String(i + 1).padStart(2);
      const type = `[${formatType(item.type)}]`.padEnd(14);
      const branch = truncate(item.branch, 16).padEnd(16);
      const msg = truncate(item.message, 40);
      console.log(`  ${num}  ${type}${branch}${msg}`);
    }
    console.log("\n  [number] jump  [d+number] dismiss  [c] clear  [q] quit");
  };

  render();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<CommandResult>((resolve) => {
    const prompt = () => {
      rl.question("  > ", async (input) => {
        const trimmed = input.trim().toLowerCase();

        if (trimmed === "q" || trimmed === "") {
          rl.close();
          resolve(ok());
          return;
        }

        if (trimmed === "c") {
          clearAll();
          items.length = 0;
          console.log("  Cleared all items.");
          rl.close();
          resolve(ok());
          return;
        }

        if (/^d\d+$/.test(trimmed)) {
          const num = Number.parseInt(trimmed.slice(1), 10);
          if (num >= 1 && num <= items.length) {
            // biome-ignore lint/style/noNonNullAssertion: guarded by bounds check
            const item = items[num - 1]!;
            removeItem(item.id);
            items.splice(num - 1, 1);
            console.log(`  Dismissed: ${item.branch}`);
            if (items.length === 0) {
              console.log("  Queue empty.");
              rl.close();
              resolve(ok());
              return;
            }
            render();
            prompt();
            return;
          }
        }

        if (/^\d+$/.test(trimmed)) {
          const num = Number.parseInt(trimmed, 10);
          if (num >= 1 && num <= items.length) {
            // biome-ignore lint/style/noNonNullAssertion: guarded by bounds check
            const item = items[num - 1]!;
            rl.close();
            const jumped = await queueInternals.jumpToItem(item);
            if (!jumped) {
              console.log(`  Failed to jump to ${item.session}`);
            }
            resolve(ok());
            return;
          }
        }

        console.log("  Invalid input.");
        prompt();
      });
    };

    prompt();
  });
}

export async function queueCommand(
  options: QueueOptions,
): Promise<CommandResult> {
  if (options.count) {
    const output = formatCount(
      (await listItems({ validatePanes: false, logWarnings: false })).length,
    );
    if (output) {
      process.stdout.write(output);
    }
    return ok();
  }

  if (options.jump) {
    const items = await listItems();
    const item = items.find((i) => i.id === options.jump);
    if (!item) {
      return err(`Queue item '${options.jump}' not found`, "queue_error");
    }
    const jumped = await queueInternals.jumpToItem(item);
    if (!jumped) {
      return err(`Failed to jump to session '${item.session}'`, "queue_error");
    }
    return ok();
  }

  if (options.dismiss) {
    const removed = removeItem(options.dismiss);
    if (!removed) {
      return err(`Queue item '${options.dismiss}' not found`, "queue_error");
    }
    logger.success("Item dismissed");
    return ok();
  }

  if (options.clear) {
    const count = clearAll();
    logger.success(`Cleared ${count} items`);
    return ok();
  }

  if (options.interactive) {
    return interactiveMode();
  }

  // Default: list items
  const items = await listItems();
  if (items.length === 0) {
    logger.info("No pending notifications");
    return ok();
  }

  for (const item of items) {
    const type = `[${formatType(item.type)}]`.padEnd(14);
    const branch = item.branch.padEnd(20);
    const age = formatAge(item.timestamp);
    console.log(`  ${item.id}  ${type}${branch}${age}  ${item.message}`);
  }

  return ok();
}

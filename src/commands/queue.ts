import { createInterface } from "node:readline";
import { Console, Effect } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { execProcess, getProcessErrorMessage } from "../services/process";
import {
  type ListItemsOptions,
  type QueueItem,
  QueueStorage,
  type QueueStorageService,
} from "../services/queue-storage";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

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

export function formatCount(count: number): string {
  if (count === 0) return "";
  return `\u{1F514} ${count}`;
}

export const queueInternals = {
  jumpToItem: (
    queueStorage: QueueStorageService,
    item: QueueItem,
  ): Effect.Effect<boolean, never, WctServices> =>
    Effect.catch(
      Effect.gen(function* () {
        yield* Effect.mapError(
          execProcess("tmux", ["switch-client", "-t", `=${item.session}`]),
          (error) =>
            commandError(
              "queue_error",
              `Failed to switch to session '${item.session}'`,
              error,
            ),
        );
        yield* Effect.mapError(
          execProcess("tmux", ["select-pane", "-t", item.pane]),
          (error) =>
            commandError(
              "queue_error",
              `Failed to select pane '${item.pane}'`,
              error,
            ),
        );
        yield* queueStorage.removeItem(item.id);
        return true;
      }),
      (error) =>
        logger
          .warn(
            `Failed to jump to queue item session='${item.session}' pane='${item.pane}': ${getProcessErrorMessage(error)}`,
          )
          .pipe(Effect.as(false)),
    ),
};

function listQueueItems(
  queueStorage: QueueStorageService,
  options: ListItemsOptions = {},
): Effect.Effect<QueueItem[], WctError, WctServices> {
  return queueStorage.listItems(options);
}

function interactiveMode(
  queueStorage: QueueStorageService,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const items = yield* listQueueItems(queueStorage);

    if (items.length === 0) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            rl.question(
              "\n  No pending notifications. Press enter to close.\n",
              () => {
                rl.close();
                resolve();
              },
            );
          }),
      );
      return;
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

    const readInput = () =>
      Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            rl.question("  > ", resolve);
          }),
      );

    const prompt = (): Effect.Effect<void, WctError, WctServices> =>
      Effect.gen(function* () {
        const input = yield* readInput();
        const trimmed = input.trim().toLowerCase();

        if (trimmed === "q" || trimmed === "") {
          rl.close();
          return;
        }

        if (trimmed === "c") {
          yield* queueStorage.clearAll();
          items.length = 0;
          yield* Console.log("  Cleared all items.");
          rl.close();
          return;
        }

        if (/^d\d+$/.test(trimmed)) {
          const num = Number.parseInt(trimmed.slice(1), 10);
          if (num >= 1 && num <= items.length) {
            // biome-ignore lint/style/noNonNullAssertion: guarded by bounds check
            const item = items[num - 1]!;
            yield* queueStorage.removeItem(item.id);
            items.splice(num - 1, 1);
            yield* Console.log(`  Dismissed: ${item.branch}`);
            if (items.length === 0) {
              yield* Console.log("  Queue empty.");
              rl.close();
              return;
            }
            render();
            return yield* prompt();
          }
        }

        if (/^\d+$/.test(trimmed)) {
          const num = Number.parseInt(trimmed, 10);
          if (num >= 1 && num <= items.length) {
            // biome-ignore lint/style/noNonNullAssertion: guarded by bounds check
            const item = items[num - 1]!;
            rl.close();
            const jumped = yield* queueInternals.jumpToItem(queueStorage, item);
            if (!jumped) {
              yield* Console.log(`  Failed to jump to ${item.session}`);
            }
            return;
          }
        }

        yield* Console.log("  Invalid input.");
        return yield* prompt();
      });

    yield* prompt();
  });
}

export function queueCommand(
  options: QueueOptions,
): Effect.Effect<void, WctError, WctServices> {
  return QueueStorage.use((queueStorage) =>
    Effect.gen(function* () {
      if (options.count) {
        const items = yield* listQueueItems(queueStorage, {
          validatePanes: false,
          logWarnings: false,
        });
        const output = formatCount(items.length);
        if (output) {
          yield* Effect.sync(() => {
            process.stdout.write(output);
          });
        }
        return;
      }

      if (options.jump) {
        const items = yield* listQueueItems(queueStorage);
        const item = items.find((i) => i.id === options.jump);
        if (!item) {
          return yield* Effect.fail(
            commandError(
              "queue_error",
              `Queue item '${options.jump}' not found`,
            ),
          );
        }
        const jumped = yield* queueInternals.jumpToItem(queueStorage, item);
        if (!jumped) {
          return yield* Effect.fail(
            commandError(
              "queue_error",
              `Failed to jump to session '${item.session}'`,
            ),
          );
        }
        return;
      }

      const dismissId = options.dismiss;
      if (dismissId) {
        const removed = yield* queueStorage.removeItem(dismissId);
        if (!removed) {
          return yield* Effect.fail(
            commandError("queue_error", `Queue item '${dismissId}' not found`),
          );
        }
        yield* logger.success("Item dismissed");
        return;
      }

      if (options.clear) {
        const count = yield* queueStorage.clearAll();
        yield* logger.success(`Cleared ${count} items`);
        return;
      }

      if (options.interactive) {
        yield* interactiveMode(queueStorage);
        return;
      }

      const items = yield* listQueueItems(queueStorage);
      if (items.length === 0) {
        yield* logger.info("No pending notifications");
        return;
      }

      for (const item of items) {
        const type = `[${formatType(item.type)}]`.padEnd(14);
        const branch = item.branch.padEnd(20);
        const age = formatAge(item.timestamp);
        yield* Console.log(
          `  ${item.id}  ${type}${branch}${age}  ${item.message}`,
        );
      }
    }),
  );
}

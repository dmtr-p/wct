import { Console, Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { getProcessErrorMessage } from "../services/process";
import {
  type ListItemsOptions,
  type QueueItem,
  QueueStorage,
  type QueueStorageService,
} from "../services/queue-storage";
import { TmuxService } from "../services/tmux";
import { jsonSuccess } from "../utils/json-output";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "queue",
  description: "Manage the agent notification queue",
  options: [
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
  jump?: string;
  dismiss?: string;
  clear?: boolean;
}

function formatType(type: string): string {
  if (type === "permission_prompt") return "permission";
  if (type === "idle_prompt") return "question";
  return type;
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
  jumpToItem: (
    queueStorage: QueueStorageService,
    item: QueueItem,
  ): Effect.Effect<boolean, never, WctServices> =>
    Effect.catch(
      Effect.gen(function* () {
        yield* TmuxService.use((service) =>
          service.switchSession(item.session),
        );
        yield* TmuxService.use((service) => service.selectPane(item.pane));
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

export function queueCommand(
  options: QueueOptions,
): Effect.Effect<
  void,
  WctError,
  WctServices | "effect/unstable/cli/GlobalFlag/json"
> {
  return QueueStorage.use((queueStorage) =>
    Effect.gen(function* () {
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

      const json = yield* JsonFlag;
      const items = yield* listQueueItems(
        queueStorage,
        json ? { logWarnings: false } : undefined,
      );
      if (items.length === 0) {
        if (json) {
          yield* jsonSuccess([]);
          return;
        }
        yield* logger.info("No pending notifications");
        return;
      }

      if (json) {
        yield* jsonSuccess(items);
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

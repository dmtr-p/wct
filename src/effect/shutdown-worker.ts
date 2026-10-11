import type { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Effect } from "effect";
import { commandError } from "../errors";
import type {
  ShutdownMessage,
  ShutdownOutcome,
  ShutdownRequest,
} from "../services/shutdown-runner";
import { executeWorkspaceShutdown } from "../services/workspace-service";

function send(message: ShutdownMessage) {
  // The caller may disappear as soon as its pane is killed.
  if (!process.connected) return;
  try {
    process.send?.(message);
  } catch {
    /* The IPC peer may exit between the check and send. */
  }
}

export function runShutdownWorker(directory: string) {
  return Effect.gen(function* () {
    if (!process.send || !directory) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Shutdown worker requires a parent IPC channel",
        ),
      );
    }
    const request = yield* Effect.tryPromise({
      try: async () =>
        JSON.parse(
          await Bun.file(join(directory, "request.json")).text(),
        ) as ShutdownRequest,
      catch: (error) =>
        commandError(
          "unexpected_error",
          "Failed to read shutdown request",
          error,
        ),
    });
    // Bun's Process overloads hide the inherited IPC event signatures.
    const ipcEvents: EventEmitter = process;
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            ipcEvents.removeListener("message", onMessage);
            ipcEvents.removeListener("disconnect", onDisconnect);
            clearTimeout(timeout);
          };
          const onMessage = (message: unknown) => {
            if (
              typeof message === "object" &&
              message !== null &&
              "_tag" in message &&
              message._tag === "Start"
            ) {
              cleanup();
              resolve();
            }
          };
          const onDisconnect = () => {
            cleanup();
            reject(new Error("Shutdown caller exited before handoff"));
          };
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Shutdown handoff timed out"));
          }, 30000);
          ipcEvents.on("message", onMessage);
          ipcEvents.on("disconnect", onDisconnect);
          send({ _tag: "Ready" });
        }),
      catch: (error) =>
        commandError("unexpected_error", "Shutdown handoff failed", error),
    });
    const outcome: ShutdownOutcome = yield* executeWorkspaceShutdown(request, {
      event: (event) => Effect.sync(() => send({ _tag: "Event", event })),
    }).pipe(
      Effect.match({
        onSuccess: (data): ShutdownOutcome => ({ ok: true, data }),
        onFailure: (error): ShutdownOutcome => ({
          ok: false,
          error: { code: error.code, message: error.message },
        }),
      }),
      Effect.catchCause((cause) =>
        Effect.succeed<ShutdownOutcome>({
          ok: false,
          error: { code: "unexpected_error", message: Cause.pretty(cause) },
        }),
      ),
    );
    yield* Effect.tryPromise({
      try: async () => {
        await Bun.write(
          join(directory, "result.json"),
          JSON.stringify(outcome, null, 2),
        );
        await rm(join(directory, "request.json"), { force: true });
      },
      catch: (error) =>
        commandError(
          "unexpected_error",
          "Failed to save shutdown result",
          error,
        ),
    });
    send({ _tag: "Completed", outcome });
    if (process.connected) process.disconnect?.();
  });
}

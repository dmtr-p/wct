import type { EventEmitter } from "node:events";
import { join } from "node:path";
import { Cause, Effect, FileSystem } from "effect";
import { commandError, type WctError } from "../errors";
import type {
  ShutdownMessage,
  ShutdownOutcome,
  ShutdownRequest,
} from "../services/shutdown-runner";
import { executeWorkspaceShutdown } from "../services/workspace-service";

function send(message: ShutdownMessage) {
  if (!process.connected) return;
  try {
    process.send?.(message);
  } catch {
    /* The IPC peer may exit between the check and send. */
  }
}

export function waitForShutdownStart(
  ipcEvents: EventEmitter,
  sendReady: () => void,
) {
  return Effect.callback<void, WctError>((resume) => {
    const cleanup = () => {
      ipcEvents.removeListener("message", onMessage);
      ipcEvents.removeListener("disconnect", onDisconnect);
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "_tag" in message &&
        message._tag === "Start"
      ) {
        cleanup();
        resume(Effect.void);
      }
    };
    const onDisconnect = () => {
      cleanup();
      resume(
        Effect.fail(
          commandError(
            "unexpected_error",
            "Shutdown handoff failed",
            new Error("Shutdown caller exited before handoff"),
          ),
        ),
      );
    };
    ipcEvents.on("message", onMessage);
    ipcEvents.on("disconnect", onDisconnect);
    sendReady();
    return Effect.sync(() => cleanup());
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          commandError(
            "unexpected_error",
            "Shutdown handoff failed",
            new Error("Shutdown handoff timed out"),
          ),
        ),
    }),
  );
}

export function runShutdownWorker(directory: string) {
  return Effect.gen(function* () {
    if (!process.send || !directory) {
      return yield* commandError(
        "invalid_options",
        "Shutdown worker requires a parent IPC channel",
      );
    }
    const fs = yield* FileSystem.FileSystem;
    const request = yield* fs
      .readFileString(join(directory, "request.json"))
      .pipe(
        Effect.flatMap((content) =>
          Effect.try(() => JSON.parse(content) as ShutdownRequest),
        ),
        Effect.mapError((error) =>
          commandError(
            "unexpected_error",
            "Failed to read shutdown request",
            error,
          ),
        ),
      );
    // Bun's Process overloads hide the inherited IPC event signatures.
    const ipcEvents: EventEmitter = process;
    yield* waitForShutdownStart(ipcEvents, () => send({ _tag: "Ready" }));
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
    yield* Effect.gen(function* () {
      const content = yield* Effect.try(() => JSON.stringify(outcome, null, 2));
      yield* fs.writeFileString(join(directory, "result.json"), content);
      yield* fs.remove(join(directory, "request.json"), { force: true });
    }).pipe(
      Effect.mapError((error) =>
        commandError(
          "unexpected_error",
          "Failed to save shutdown result",
          error,
        ),
      ),
    );
    send({ _tag: "Completed", outcome });
    if (process.connected) process.disconnect?.();
  });
}

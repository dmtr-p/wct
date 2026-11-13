import { join } from "node:path";
import { Cause, Effect, FileSystem, type Scope } from "effect";
import { commandError, type WctError } from "../errors";
import type {
  ShutdownMessage,
  ShutdownOutcome,
  ShutdownRequest,
} from "../services/shutdown-runner";
import { CurrentWorkspaceLease } from "../services/workspace-coordination";
import { publishWorkspaceJournal } from "../services/workspace-journal";
import { executeWorkspaceShutdown } from "../services/workspace-service";
import { assertWorkspaceTarget } from "../services/workspace-target";
import { acceptWorkspaceFromCaller } from "../services/workspace-transfer";

function send(message: ShutdownMessage) {
  if (!process.connected) return;
  try {
    process.send?.(message);
  } catch {
    /* The IPC peer may exit between the check and send. */
  }
}

export function runShutdownWorker(
  directory: string,
  options: {
    publishOutcome?: (
      path: string,
      content: string,
    ) => Effect.Effect<void, WctError, Scope.Scope>;
    sendCompleted?: (outcome: ShutdownOutcome) => void;
  } = {},
) {
  return Effect.gen(function* () {
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
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
        const lease = yield* acceptWorkspaceFromCaller;
        return yield* Effect.gen(function* () {
          const outcome: ShutdownOutcome = yield* Effect.gen(function* () {
            if (request.targetEvidence)
              yield* assertWorkspaceTarget(request.targetEvidence);
            return yield* executeWorkspaceShutdown(request, {
              event: (event) =>
                Effect.sync(() => send({ _tag: "Event", event })),
            });
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
                error: {
                  code: "unexpected_error",
                  message: Cause.pretty(cause),
                },
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const content = yield* Effect.try(() =>
              JSON.stringify(outcome, null, 2),
            );
            yield* options.publishOutcome
              ? options.publishOutcome(join(directory, "result.json"), content)
              : Effect.try({
                  try: () =>
                    publishWorkspaceJournal(
                      join(directory, "result.json"),
                      content,
                    ),
                  catch: (error) =>
                    commandError(
                      "unexpected_error",
                      "Outcome publication failed",
                      error,
                    ),
                });
            yield* fs.remove(join(directory, "request.json"), { force: true });
          }).pipe(
            Effect.catch((error) =>
              lease.command(
                "Persist shutdown outcome failed",
                Effect.fail(
                  commandError(
                    "unexpected_error",
                    "Failed to save shutdown result",
                    error,
                  ),
                ),
              ),
            ),
          );
          return outcome;
        }).pipe(Effect.provideService(CurrentWorkspaceLease, lease));
      }),
    );
    // Never announce success until publication and scoped custody release finish.
    if (options.sendCompleted) options.sendCompleted(outcome);
    else send({ _tag: "Completed", outcome });
    if (process.connected) process.disconnect?.();
  });
}

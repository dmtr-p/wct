import type { EventEmitter } from "node:events";
import { Effect } from "effect";
import { commandError, toWctError, type WctError } from "../errors";
import {
  receiveWorkspaceTransfer,
  type WorkspaceLease,
  type WorkspaceTransferTicket,
} from "./workspace-coordination";
import { closeWorkspaceLock } from "./workspace-lock";

export const WORKSPACE_CUSTODY_DESCRIPTOR = 4;

type TransferMessage =
  | { _tag: "WorkspaceWorkerListening" }
  | { _tag: "WorkspaceTransfer"; ticket: WorkspaceTransferTicket }
  | { _tag: "WorkspaceReady"; nonce: string }
  | { _tag: "WorkspaceStart"; nonce: string }
  | { _tag: "WorkspaceAdopted"; nonce: string };

function hasTag(
  message: unknown,
  tag: TransferMessage["_tag"],
): message is TransferMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "_tag" in message &&
    message._tag === tag
  );
}

function handoffError(message: string, cause?: unknown) {
  return commandError("workspace_coordination_error", message, cause);
}

/** Start irrevocably retires the
 * parent's mutation authority even when delivery or the adoption ACK is lost. */
export function transferWorkspaceToWorker(
  lease: WorkspaceLease,
  command: readonly string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    beforeStart?: Effect.Effect<void, WctError>;
  } = {},
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const offer = yield* lease.offerTransfer;
      const listening = Promise.withResolvers<void>();
      const ready = Promise.withResolvers<void>();
      const adopted = Promise.withResolvers<void>();
      // Exit may reject acknowledgements before the corresponding await starts.
      for (const pending of [listening, ready, adopted])
        void pending.promise.catch(() => undefined);
      let child: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
      let committed = false;
      const awaitAck = (promise: Promise<void>) =>
        Effect.tryPromise({ try: () => promise, catch: toWctError }).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((error) =>
            handoffError(
              "Workspace worker handoff acknowledgement failed; inspect ownership before retrying",
              error,
            ),
          ),
        );
      yield* Effect.gen(function* () {
        child = yield* Effect.try({
          try: () =>
            Bun.spawn([...command], {
              cwd: options.cwd,
              env: options.env,
              detached: true,
              // Bun owns its IPC channel at index 3; custody is an explicit raw FD
              // at index 4. Scripts never receive this descriptor.
              stdio: ["ignore", "ignore", "ignore", "ignore", offer.descriptor],
              ipc: (message: unknown) => {
                if (hasTag(message, "WorkspaceWorkerListening"))
                  listening.resolve();
                else if (
                  hasTag(message, "WorkspaceReady") &&
                  "nonce" in message &&
                  message.nonce === offer.ticket.nonce
                )
                  ready.resolve();
                else if (
                  hasTag(message, "WorkspaceAdopted") &&
                  "nonce" in message &&
                  message.nonce === offer.ticket.nonce
                )
                  adopted.resolve();
              },
              onExit: () => {
                const error = handoffError(
                  "Workspace worker exited during ownership transfer",
                );
                listening.reject(error);
                ready.reject(error);
                adopted.reject(error);
              },
            }),
          catch: (error) =>
            handoffError("Cannot spawn Workspace worker", error),
        });
        yield* restore(awaitAck(listening.promise));
        const worker = child;
        yield* lease.registerTransferWorker(worker.pid);
        yield* Effect.try({
          try: () =>
            worker.send({
              _tag: "WorkspaceTransfer",
              ticket: offer.ticket,
            } satisfies TransferMessage),
          catch: toWctError,
        });
        yield* restore(awaitAck(ready.promise));
        if (options.beforeStart) yield* restore(options.beforeStart);
        yield* lease.commitTransfer;
        committed = true;
        yield* Effect.try({
          try: () =>
            worker.send({
              _tag: "WorkspaceStart",
              nonce: offer.ticket.nonce,
            } satisfies TransferMessage),
          catch: toWctError,
        });
        yield* restore(awaitAck(adopted.promise));
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (committed) {
              // The worker may already be mutating, even if its ACK never arrives.
              yield* lease.closeTransferred;
              if (exit._tag !== "Success" && child) {
                const worker = child;
                yield* Effect.sync(() => {
                  // A failed/cancelled caller must not remain alive solely for
                  // the detached worker's IPC or process handle.
                  try {
                    worker.disconnect();
                  } catch {
                    /* The worker may already have disconnected. */
                  } finally {
                    worker.unref();
                  }
                });
              }
            } else {
              if (child) {
                const worker = child;
                yield* Effect.promise(async () => {
                  worker.kill("SIGKILL");
                  await worker.exited;
                });
              }
              yield* lease.cancelTransfer.pipe(Effect.orDie);
            }
          }),
        ),
      );
      return child;
    }),
  );
}

function receiveMessage(
  tag: "WorkspaceTransfer" | "WorkspaceStart",
  announce?: () => void,
) {
  return Effect.callback<TransferMessage, WctError>((resume) => {
    const events: EventEmitter = process;
    const cleanup = () => {
      events.removeListener("message", onMessage);
      events.removeListener("disconnect", onDisconnect);
    };
    const onMessage = (message: unknown) => {
      if (hasTag(message, tag)) {
        cleanup();
        resume(Effect.succeed(message));
      }
    };
    const onDisconnect = () => {
      cleanup();
      resume(
        Effect.fail(
          handoffError(
            "Workspace caller disconnected before Start; custody remains fenced",
          ),
        ),
      );
    };
    events.on("message", onMessage);
    events.on("disconnect", onDisconnect);
    if (!process.connected) onDisconnect();
    else announce?.();
    return Effect.sync(cleanup);
  }).pipe(Effect.timeout("30 seconds"));
}

export const acceptWorkspaceFromCaller = Effect.acquireUseRelease(
  Effect.sync(() => ({ delegated: false })),
  (custody) =>
    Effect.gen(function* () {
      const preparation = yield* receiveMessage("WorkspaceTransfer", () =>
        process.send?.({
          _tag: "WorkspaceWorkerListening",
        } satisfies TransferMessage),
      );
      if (preparation._tag !== "WorkspaceTransfer")
        return yield* handoffError("Missing Workspace transfer ticket");
      const pending = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          custody.delegated = true;
          return yield* receiveWorkspaceTransfer(
            preparation.ticket,
            WORKSPACE_CUSTODY_DESCRIPTOR,
          );
        }),
      );
      return yield* Effect.gen(function* () {
        const start = yield* receiveMessage("WorkspaceStart", () =>
          process.send?.({
            _tag: "WorkspaceReady",
            nonce: preparation.ticket.nonce,
          } satisfies TransferMessage),
        );
        if (
          start._tag !== "WorkspaceStart" ||
          start.nonce !== preparation.ticket.nonce
        )
          return yield* handoffError(
            "Workspace Start does not match prepared custody",
          );
        const lease = yield* pending.adopt;
        // After adoption, caller disconnect has no authority over the worker.
        yield* Effect.sync(() => {
          try {
            process.send?.({
              _tag: "WorkspaceAdopted",
              nonce: preparation.ticket.nonce,
            } satisfies TransferMessage);
          } catch {
            /* Custody is durable even if the acknowledgement cannot arrive. */
          }
        });
        return lease;
      }).pipe(Effect.onError(() => pending.closeUnadopted));
    }),
  (custody) =>
    Effect.sync(() => {
      if (!custody.delegated) closeWorkspaceLock(WORKSPACE_CUSTODY_DESCRIPTOR);
    }),
);

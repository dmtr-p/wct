import { Database } from "bun:sqlite";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { runBunPromise } from "../../src/effect/runtime";
import { runMigrations } from "../../src/services/db";
import { execShell } from "../../src/services/process";
import {
  CurrentWorkspaceLease,
  makeWorkspaceCoordinationService,
  receiveWorkspaceTransfer,
  type WorkspaceTransferTicket,
} from "../../src/services/workspace-coordination";
import {
  acceptWorkspaceFromCaller,
  transferWorkspaceToWorker,
} from "../../src/services/workspace-transfer";

interface Arguments {
  root: string;
  mainRepoPath: string;
  branch: string;
  mode: "hold" | "command" | "transfer" | "worker" | "background" | "registry";
  script?: string;
  marker?: string;
  home?: string;
  stage?: "reject" | "before-adopt" | "drop-adopted";
  workerStage?: "reject" | "before-adopt" | "drop-adopted";
  finishMarker?: string;
  cancelBeforeStart?: boolean;
  cancellableTransfer?: boolean;
  omitTicket?: boolean;
  catchDisconnect?: boolean;
}
const args = JSON.parse(process.argv[2] ?? "{}") as Arguments;
const send = (value: unknown) => {
  if (process.connected) process.send?.(value);
};
function waitMessage(tag: string, announce?: () => void) {
  return Effect.callback<unknown>((resume) => {
    const events: EventEmitter = process;
    const listener = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "_tag" in message &&
        message._tag === tag
      ) {
        events.removeListener("message", listener);
        resume(Effect.succeed(message));
      }
    };
    events.on("message", listener);
    announce?.();
    return Effect.sync(() => events.removeListener("message", listener));
  });
}

function receiveUnacknowledgedTransfer(
  stage: Arguments["stage"],
  marker: string | undefined,
) {
  return Effect.gen(function* () {
    const preparation = yield* waitMessage("WorkspaceTransfer", () =>
      send({ _tag: "WorkspaceWorkerListening" }),
    );
    const ticket = (preparation as { ticket: WorkspaceTransferTicket }).ticket;
    const pending = yield* receiveWorkspaceTransfer(ticket, 4);
    yield* waitMessage("WorkspaceStart", () =>
      send({ _tag: "WorkspaceReady", nonce: ticket.nonce }),
    );
    if (stage === "drop-adopted") return yield* pending.adopt;
    yield* Effect.sync(() =>
      writeFileSync(`${marker}.before-adopt`, String(process.pid)),
    );
    return yield* Effect.forever(Effect.sleep("1 second"));
  });
}

const program = Effect.scoped(
  Effect.gen(function* () {
    if (args.mode === "registry") {
      yield* Effect.sync(() => {
        mkdirSync(join(args.home ?? args.root, ".wct"), { recursive: true });
        const db = new Database(join(args.home ?? args.root, ".wct/wct.db"));
        try {
          runMigrations(db);
          db.run("INSERT INTO registry VALUES (?, ?, ?, ?)", [
            "fixture",
            args.mainRepoPath,
            "fixture",
            1,
          ]);
        } finally {
          db.close();
        }
      });
      return;
    }
    if (args.mode === "background") {
      yield* Effect.sync(() =>
        writeFileSync(args.marker ?? "", String(process.pid)),
      );
      return yield* Effect.forever(Effect.sleep("1 second"));
    }
    if (args.mode === "worker" && args.stage === "reject")
      return yield* Effect.die(new Error("Rejected worker fixture"));
    if (args.mode === "worker" && args.catchDisconnect) {
      yield* acceptWorkspaceFromCaller.pipe(
        Effect.catchCause(() =>
          Effect.sync(() =>
            writeFileSync(`${args.marker}.closed`, String(process.pid)),
          ),
        ),
      );
      return yield* Effect.forever(Effect.sleep("1 second"));
    }
    const service = yield* makeWorkspaceCoordinationService({
      root: args.root,
      pollMilliseconds: 10,
    });
    const lease =
      args.mode === "worker"
        ? args.stage === "before-adopt" || args.stage === "drop-adopted"
          ? yield* receiveUnacknowledgedTransfer(args.stage, args.marker)
          : yield* acceptWorkspaceFromCaller
        : yield* service.acquire(args, {
            onWait: Effect.sync(() => send({ _tag: "Waiting" })),
          });
    yield* Effect.sync(() => {
      send({ _tag: "Acquired", ownership: lease.ownership });
      if (args.mode === "worker" && args.marker)
        writeFileSync(args.marker, String(process.pid));
    });
    if (args.mode === "transfer") {
      if (args.omitTicket) {
        const offer = yield* lease.offerTransfer;
        const worker = yield* Effect.sync(() =>
          Bun.spawn(
            [
              process.execPath,
              "run",
              import.meta.filename,
              JSON.stringify({
                ...args,
                mode: "worker",
                catchDisconnect: true,
              }),
            ],
            {
              detached: true,
              stdio: ["ignore", "ignore", "ignore", "ignore", offer.descriptor],
              ipc: (message: unknown, child) => {
                if (
                  typeof message === "object" &&
                  message !== null &&
                  "_tag" in message &&
                  message._tag === "WorkspaceWorkerListening"
                )
                  send({ _tag: "Ready", pid: child.pid });
              },
            },
          ),
        );
        yield* Effect.promise(() => worker.exited);
        return;
      }
      const transfer = transferWorkspaceToWorker(
        lease,
        [
          process.execPath,
          "run",
          import.meta.filename,
          JSON.stringify({ ...args, mode: "worker", stage: args.workerStage }),
        ],
        {
          beforeStart: Effect.gen(function* () {
            yield* waitMessage("Start", () => send({ _tag: "Ready" }));
            if (args.cancelBeforeStart) return yield* Effect.interrupt;
          }),
        },
      );
      const worker = yield* args.cancellableTransfer
        ? Effect.raceFirst(
            transfer,
            waitMessage("Cancel").pipe(Effect.flatMap(() => Effect.interrupt)),
          )
        : transfer;
      yield* Effect.sync(() => send({ _tag: "Transferred", pid: worker?.pid }));
      if (worker) yield* Effect.promise(() => worker.exited);
      return;
    }
    if (args.script) {
      yield* execShell(args.script).pipe(
        Effect.provideService(CurrentWorkspaceLease, lease),
      );
      yield* Effect.sync(() => send({ _tag: "CommandCompleted" }));
    }
    if (args.mode === "worker") {
      if (args.finishMarker) {
        while (!(yield* Effect.sync(() => existsSync(args.finishMarker ?? ""))))
          yield* Effect.sleep("10 millis");
      } else {
        // Keep custody after adoption until the test explicitly terminates us.
        return yield* Effect.forever(Effect.sleep("1 second"));
      }
    } else {
      yield* waitMessage("Release", () => send({ _tag: "Idle" }));
    }
  }),
);

await runBunPromise(program).catch((error: unknown) => {
  send({ _tag: "Failed", error: String(error) });
  process.exitCode = 1;
});
if (process.connected) process.disconnect?.();

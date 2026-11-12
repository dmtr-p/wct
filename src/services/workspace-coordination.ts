import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Context, Effect, FileSystem, Schema, type Scope } from "effect";
import { commandError, WctCommandError, type WctError } from "../errors";
import { getWctDir } from "./db";
import { type WorkspaceIdentityKey, workspaceIdentityKey } from "./identities";
import { canonicalSessionPath } from "./session-identity";
import {
  closeWorkspaceLock,
  openWorkspaceLock,
  type ProcessGeneration,
  processGeneration,
  protectWorkspaceDescriptor,
  sameProcessGeneration,
  tryWorkspaceLock,
} from "./workspace-lock";

const Generation = Schema.Struct({
  pid: Schema.Finite,
  boot: Schema.String,
  started: Schema.String,
});
const Reservation = Schema.Struct({
  operationId: Schema.String,
  generation: Schema.String,
  owner: Generation,
  phase: Schema.Literals(["owned", "command", "transfer"]),
  command: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      child: Schema.optional(
        Schema.Struct({
          pid: Schema.Finite,
          generation: Schema.NullOr(Generation),
        }),
      ),
    }),
  ),
  transfer: Schema.optional(
    Schema.Struct({
      nonce: Schema.String,
      generation: Schema.String,
      committed: Schema.Boolean,
    }),
  ),
});
const Journal = Schema.Struct({
  version: Schema.Literal(1),
  identity: Schema.String,
  reservation: Schema.NullOr(Reservation),
  reconciliation: Schema.optional(
    Schema.Struct({
      operationId: Schema.String,
      generation: Schema.String,
      requestId: Schema.String,
      reason: Schema.String,
    }),
  ),
});
export type WorkspaceReservation = typeof Reservation.Type;
type WorkspaceJournal = typeof Journal.Type;

export interface WorkspaceCoordinationTarget {
  mainRepoPath: string;
  branch: string;
}
export interface WorkspaceOperationFence {
  operationId: string;
  generation: string;
}
export interface WorkspaceTransferTicket extends WorkspaceOperationFence {
  root: string;
  identity: string;
  nonce: string;
  nextGeneration: string;
}
export type WorkspaceCoordinationStatus =
  | { status: "available" }
  | { status: "busy"; reservation?: WorkspaceReservation }
  | { status: "outcome-unknown"; reservation: WorkspaceReservation };

export interface ReconcileWorkspaceOperation {
  expectedOwnership: WorkspaceOperationFence;
  acknowledgeUncertainSideEffects: true;
  resolution: "release-after-inspection";
  requestId: string;
  reason: string;
}

export interface WorkspaceLease {
  readonly identity: WorkspaceIdentityKey;
  readonly ownership: WorkspaceOperationFence;
  /** Raw collection acknowledges only a known exit with drained output. */
  command: <A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, WctError, R>;
  childStarted: (pid: number) => Effect.Effect<void, WctError>;
  offerTransfer: Effect.Effect<
    { ticket: WorkspaceTransferTicket; descriptor: number },
    WctError
  >;
  commitTransfer: Effect.Effect<void, WctError>;
  /** Call only after the prospective worker is proven exited, before Start. */
  cancelTransfer: Effect.Effect<void, WctError>;
  closeTransferred: Effect.Effect<void>;
}

export const CurrentWorkspaceLease = Context.Reference<
  WorkspaceLease | undefined
>("wct/CurrentWorkspaceLease", { defaultValue: () => undefined });

function coordinationError(details: string, cause?: unknown): WctError {
  return commandError("workspace_coordination_error", details, cause);
}

function guarded<A>(action: () => A): Effect.Effect<A, WctError> {
  return Effect.try({
    try: action,
    catch: (error) =>
      error instanceof WctCommandError &&
      error.code === "workspace_coordination_error"
        ? error
        : coordinationError("Workspace coordination failed", error),
  });
}

function prepareRoot(path: string): string {
  const absolute = resolve(path);
  try {
    mkdirSync(absolute, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  // The first fence must not live only in a newly created, unflushed directory
  // entry. Callers supply an existing parent (HOME for the default root).
  const parent = openSync(dirname(absolute), constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  const info = lstatSync(absolute);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  ) {
    throw coordinationError(
      "Workspace coordination directory must be an owner-only directory (0700)",
    );
  }
  return realpathSync(absolute);
}

function paths(root: string, identity: string) {
  const hash = new Bun.CryptoHasher("sha256").update(identity).digest("hex");
  return {
    lock: join(root, `${hash}.lock`),
    journal: join(root, `${hash}.json`),
  };
}

function readJournal(path: string, identity: string): WorkspaceJournal {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { version: 1, identity, reservation: null };
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 64 * 1024)
      throw coordinationError("Invalid Workspace ownership journal");
    const journal = Schema.decodeUnknownSync(Journal)(
      JSON.parse(readFileSync(fd, "utf8")),
    );
    if (
      journal.identity !== identity ||
      (journal.reservation?.phase === "command" &&
        !journal.reservation.command) ||
      (journal.reservation?.phase === "transfer" &&
        !journal.reservation.transfer)
    )
      throw coordinationError(
        "Workspace ownership journal does not match its identity or phase",
      );
    return journal;
  } finally {
    closeSync(fd);
  }
}

// The fence is durable before the process boundary opens: file fsync, atomic
// same-directory rename, then directory fsync. Release uses the same ordering.
function writeJournal(path: string, journal: WorkspaceJournal): void {
  const content = JSON.stringify(journal);
  if (Buffer.byteLength(content) > 64 * 1024)
    throw coordinationError("Workspace ownership journal exceeds 64 KiB");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Preserve the write failure. */
    }
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function sameFence(
  left: WorkspaceOperationFence,
  right: WorkspaceOperationFence,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.generation === right.generation
  );
}

function unknownOutcome(reservation: WorkspaceReservation): WctError {
  return coordinationError(
    `Workspace is blocked: outcome unknown for operation ${reservation.operationId}, generation ${reservation.generation}. Inspect potentially surviving setup/down work, then explicitly reconcile this exact reservation with release-after-inspection; scripts will not be replayed.`,
  );
}

function makeLease(
  root: string,
  identity: WorkspaceIdentityKey,
  fd: number,
  reservation: WorkspaceReservation,
) {
  const path = paths(root, identity).journal;
  const ownership = {
    operationId: reservation.operationId,
    generation: reservation.generation,
  };
  let mode: "owned" | "offered" | "committed" | "closed" = "owned";
  let uncertain = false;
  let commandActive = false;
  const update = (
    f: (current: WorkspaceReservation) => WorkspaceReservation,
  ) => {
    const journal = readJournal(path, identity);
    if (!journal.reservation || !sameFence(journal.reservation, ownership))
      throw coordinationError(
        "Workspace ownership changed; refusing stale owner mutation",
      );
    writeJournal(path, { ...journal, reservation: f(journal.reservation) });
  };
  const requireOwned = () => {
    if (mode !== "owned" || uncertain)
      throw coordinationError(
        "Workspace ownership is transferred or uncertain",
      );
  };
  const close = () => {
    if (mode === "closed") return;
    mode = "closed";
    closeWorkspaceLock(fd);
  };
  const lease: WorkspaceLease = {
    identity,
    ownership,
    command: (name, effect) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* guarded(() => {
            requireOwned();
            if (commandActive)
              throw coordinationError(
                "Concurrent commands cannot share one Workspace lease",
              );
            // Set the in-memory latch before attempting persistence: even an fsync
            // failure after rename must never be mistaken for acknowledged work.
            uncertain = true;
            update(() => ({
              ...reservation,
              phase: "command",
              command: { id: randomUUID(), name },
            }));
            commandActive = true;
          });
          const result = yield* restore(effect).pipe(
            Effect.mapError((error) =>
              coordinationError(
                `Workspace command completion is uncertain; operation ${ownership.operationId}, generation ${ownership.generation} remains fenced and requires explicit reconciliation`,
                error,
              ),
            ),
            Effect.onExit((exit) => {
              commandActive = false;
              if (exit._tag !== "Success") return Effect.void;
              return guarded(() => {
                update((current) => ({
                  ...current,
                  phase: "owned",
                  command: undefined,
                }));
                uncertain = false;
              });
            }),
          );
          return result;
        }),
      ),
    childStarted: (pid) =>
      guarded(() => {
        if (mode !== "owned" || !commandActive)
          throw coordinationError("No active Workspace command");
        let generation: ProcessGeneration | null = null;
        try {
          generation = processGeneration(pid);
        } catch {
          /* A short-lived child may already have exited. */
        }
        update((current) => {
          if (!current.command)
            throw coordinationError("Missing Workspace command boundary");
          return {
            ...current,
            command: { ...current.command, child: { pid, generation } },
          };
        });
      }),
    offerTransfer: guarded(() => {
      requireOwned();
      const transfer = {
        nonce: randomUUID(),
        generation: randomUUID(),
        committed: false,
      };
      // An uncertain write leaves the local handle unable to clear the fence.
      mode = "offered";
      update((current) => ({ ...current, phase: "transfer", transfer }));
      return {
        descriptor: fd,
        ticket: {
          root,
          identity,
          ...ownership,
          nonce: transfer.nonce,
          nextGeneration: transfer.generation,
        },
      };
    }),
    commitTransfer: guarded(() => {
      if (mode !== "offered")
        throw coordinationError("Workspace transfer is not prepared");
      mode = "committed";
      update((current) => {
        if (!current.transfer)
          throw coordinationError("Missing prepared Workspace transfer");
        return {
          ...current,
          transfer: { ...current.transfer, committed: true },
        };
      });
    }),
    cancelTransfer: guarded(() => {
      if (mode !== "offered")
        throw coordinationError("Cannot cancel a committed Workspace transfer");
      update((current) => ({
        ...current,
        phase: "owned",
        transfer: undefined,
      }));
      mode = "owned";
    }),
    closeTransferred: Effect.sync(close),
  };
  const release = Effect.sync(() => {
    if (mode === "closed") return;
    try {
      if (mode === "owned" && !uncertain && !commandActive) {
        const journal = readJournal(path, identity);
        if (journal.reservation && sameFence(journal.reservation, ownership))
          writeJournal(path, { ...journal, reservation: null });
      }
    } finally {
      close();
    }
  });
  return { lease, release };
}

export interface WorkspaceCoordinationServiceApi {
  acquire: (
    target: WorkspaceCoordinationTarget,
    options?: { onWait?: Effect.Effect<void> },
  ) => Effect.Effect<WorkspaceLease, WctError, Scope.Scope>;
  inspect: (
    target: WorkspaceCoordinationTarget,
  ) => Effect.Effect<WorkspaceCoordinationStatus, WctError>;
  reconcile: (
    target: WorkspaceCoordinationTarget,
    request: ReconcileWorkspaceOperation,
  ) => Effect.Effect<void, WctError>;
}
export const WorkspaceCoordinationService =
  Context.Service<WorkspaceCoordinationServiceApi>(
    "wct/WorkspaceCoordinationService",
  );

export function makeWorkspaceCoordinationService(
  options: { root?: string; pollMilliseconds?: number } = {},
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* guarded(() =>
      prepareRoot(options.root ?? `${getWctDir()}-coordination`),
    );
    const pollMilliseconds = Math.max(1, options.pollMilliseconds ?? 100);
    const identityOf = (target: WorkspaceCoordinationTarget) =>
      canonicalSessionPath(target.mainRepoPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.map((path) => workspaceIdentityKey(path, target.branch)),
        Effect.mapError((error) =>
          coordinationError("Cannot canonicalize Workspace identity", error),
        ),
      );
    const withLock = <A>(
      identity: WorkspaceIdentityKey,
      f: (path: string) => A,
    ) =>
      guarded(() => {
        const files = paths(root, identity);
        const fd = openWorkspaceLock(files.lock);
        try {
          if (!tryWorkspaceLock(fd))
            throw coordinationError(
              "Workspace has a live custodian; reconciliation is refused",
            );
          return f(files.journal);
        } finally {
          closeWorkspaceLock(fd);
        }
      });
    const service: WorkspaceCoordinationServiceApi = {
      acquire: (target, options) =>
        Effect.gen(function* () {
          const identity = yield* identityOf(target);
          const files = paths(root, identity);
          const handle = yield* Effect.acquireRelease(
            guarded(() => {
              const fd = openWorkspaceLock(files.lock);
              return { fd, release: Effect.sync(() => closeWorkspaceLock(fd)) };
            }),
            (handle) => handle.release,
          );
          while (!(yield* guarded(() => tryWorkspaceLock(handle.fd)))) {
            if (options?.onWait) yield* options.onWait.pipe(Effect.ignoreCause);
            yield* Effect.sleep(`${pollMilliseconds} millis`);
          }
          return yield* guarded(() => {
            const journal = readJournal(files.journal, identity);
            if (journal.reservation) throw unknownOutcome(journal.reservation);
            const reservation: WorkspaceReservation = {
              operationId: randomUUID(),
              generation: randomUUID(),
              owner: processGeneration(process.pid),
              phase: "owned",
            };
            writeJournal(files.journal, { ...journal, reservation });
            const owned = makeLease(root, identity, handle.fd, reservation);
            handle.release = owned.release;
            return owned.lease;
          });
        }),
      inspect: (target) =>
        Effect.gen(function* () {
          const identity = yield* identityOf(target);
          return yield* guarded(() => {
            const files = paths(root, identity);
            const fd = openWorkspaceLock(files.lock);
            try {
              const locked = tryWorkspaceLock(fd);
              const journal = readJournal(files.journal, identity);
              if (!locked)
                return {
                  status: "busy" as const,
                  reservation: journal.reservation ?? undefined,
                };
              return journal.reservation
                ? {
                    status: "outcome-unknown" as const,
                    reservation: journal.reservation,
                  }
                : { status: "available" as const };
            } finally {
              closeWorkspaceLock(fd);
            }
          });
        }),
      reconcile: (target, request) =>
        Effect.gen(function* () {
          const identity = yield* identityOf(target);
          yield* withLock(identity, (path) => {
            if (
              request.acknowledgeUncertainSideEffects !== true ||
              request.resolution !== "release-after-inspection" ||
              !request.requestId.trim() ||
              !request.reason.trim()
            )
              throw coordinationError(
                "Explicit reconciliation requires acknowledgement, request ID, and an inspection reason",
              );
            const journal = readJournal(path, identity);
            if (
              !journal.reservation ||
              !sameFence(journal.reservation, request.expectedOwnership)
            )
              throw coordinationError(
                "Stale reconciliation: the exact uncertain operation and generation no longer match",
              );
            writeJournal(path, {
              ...journal,
              reservation: null,
              reconciliation: {
                ...request.expectedOwnership,
                requestId: request.requestId,
                reason: request.reason,
              },
            });
          });
        }),
    };
    return service;
  });
}

/** Take custody only from the inherited descriptor, never by opening/reacquiring. */
export function receiveWorkspaceTransfer(
  ticket: WorkspaceTransferTicket,
  descriptor: number,
) {
  return Effect.gen(function* () {
    const custody = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const state = { adopted: false, closed: false };
        return {
          state,
          close: Effect.sync(() => {
            if (!state.adopted && !state.closed) {
              state.closed = true;
              closeWorkspaceLock(descriptor);
            }
          }),
        };
      }),
      (custody) => custody.close,
    );
    const pending = yield* guarded(() => {
      const root = prepareRoot(ticket.root);
      const files = paths(root, ticket.identity);
      const expected = lstatSync(files.lock);
      const actual = fstatSync(descriptor);
      if (
        !actual.isFile() ||
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        !tryWorkspaceLock(descriptor)
      )
        throw coordinationError(
          "Worker did not inherit Workspace lock custody",
        );
      protectWorkspaceDescriptor(descriptor);
      const journal = readJournal(files.journal, ticket.identity);
      const current = journal.reservation;
      if (
        !current ||
        !sameFence(current, ticket) ||
        current.phase !== "transfer" ||
        current.transfer?.nonce !== ticket.nonce ||
        current.transfer.generation !== ticket.nextGeneration
      )
        throw coordinationError("Stale or invalid Workspace transfer ticket");
      return { root, files, current };
    }).pipe(Effect.onError(() => custody.close));
    return {
      closeUnadopted: custody.close,
      adopt: Effect.acquireRelease(
        guarded(() => {
          if (custody.state.adopted || custody.state.closed)
            throw coordinationError("Workspace transfer already consumed");
          const owner = processGeneration(process.pid);
          if (sameProcessGeneration(owner, pending.current.owner))
            throw coordinationError(
              "Workspace worker must be a separate process generation",
            );
          const journal = readJournal(pending.files.journal, ticket.identity);
          if (
            !journal.reservation ||
            !sameFence(journal.reservation, ticket) ||
            journal.reservation.transfer?.nonce !== ticket.nonce ||
            !journal.reservation.transfer.committed
          )
            throw coordinationError(
              "Workspace transfer changed before adoption",
            );
          const reservation: WorkspaceReservation = {
            operationId: ticket.operationId,
            generation: ticket.nextGeneration,
            owner,
            phase: "owned",
          };
          writeJournal(pending.files.journal, { ...journal, reservation });
          const identity = workspaceIdentityKey(
            ...splitIdentity(ticket.identity),
          );
          const owned = makeLease(
            pending.root,
            identity,
            descriptor,
            reservation,
          );
          custody.state.adopted = true;
          return owned;
        }),
        (owned) => owned.release,
      ).pipe(
        Effect.map((owned) => owned.lease),
        Effect.onError(() => custody.close),
      ),
    };
  });
}

function splitIdentity(identity: string): [string, string] {
  const parts = identity.split("\0");
  if (parts.length !== 2 || !parts[0] || parts[1] === undefined)
    throw coordinationError("Invalid Workspace identity");
  return [parts[0], parts[1]];
}

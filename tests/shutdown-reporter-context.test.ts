import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Context, Effect, FileSystem, PlatformError } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import { runBunPromise } from "../src/effect/runtime";
import { commandError } from "../src/errors";
import { workspaceIdentityKey } from "../src/services/identities";
import { runDetachedShutdown } from "../src/services/shutdown-runner";
import {
  CurrentWorkspaceLease,
  type WorkspaceLease,
} from "../src/services/workspace-coordination";
import type {
  WorkspaceDownResult,
  WorkspaceReporterEvent,
} from "../src/services/workspace-service";

const ReporterEvents = Context.Reference<WorkspaceReporterEvent[]>(
  "wct/test/ReporterEvents",
  { defaultValue: () => [] },
);

const ticket = {
  root: "/fixture",
  identity: workspaceIdentityKey("/fixture", "feature"),
  operationId: "operation",
  generation: "caller",
  nextGeneration: "worker",
  nonce: "nonce",
};
const lease: WorkspaceLease = {
  identity: ticket.identity,
  ownership: ticket,
  command: (_name, effect) =>
    Effect.mapError(effect, (error) =>
      commandError("workspace_coordination_error", String(error)),
    ),
  childStarted: () => Effect.void,
  offerTransfer: Effect.succeed({ ticket, descriptor: 4 }),
  commitTransfer: Effect.void,
  registerTransferWorker: () => Effect.void,
  cancelTransfer: Effect.void,
  closeTransferred: Effect.void,
};

let directory: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test.each(["success", "failure", "defect", "mixed"])(
  "shutdown IPC reporters preserve context and event order despite %s",
  async (mode) => {
    const events: WorkspaceReporterEvent[] = [];
    const result: WorkspaceDownResult = {
      operation: "down",
      worktreePath: join(tmpdir(), "wct-reporter-target"),
      sessionName: "wct-reporter-target",
      existed: true,
      status: "killed",
      attempts: {
        kill: { attempted: true, ok: true, value: null },
        down: { attempted: true, ok: true, value: [] },
      },
      warnings: [],
    };
    const phase: WorkspaceReporterEvent = {
      operation: "down",
      _tag: "PhaseStarted",
      phase: { _tag: "StoppingTmuxSession" },
    };
    const killed: WorkspaceReporterEvent = {
      operation: "down",
      _tag: "SessionKilled",
      sessionName: result.sessionName,
    };
    const child = {
      pid: process.pid,
      disconnect: vi.fn(),
      unref: vi.fn(),
      send: (message: { _tag: string }) => {
        if (message._tag === "WorkspaceTransfer") {
          queueMicrotask(() =>
            emit({ _tag: "WorkspaceReady", nonce: ticket.nonce }),
          );
          return;
        }
        emit({ _tag: "WorkspaceAdopted", nonce: ticket.nonce });
        emit({ _tag: "Event", event: phase });
        emit({ _tag: "Event", event: killed });
        emit({ _tag: "Completed", outcome: { ok: true, data: result } });
      },
      kill: vi.fn(),
    } as unknown as ReturnType<typeof Bun.spawn>;
    const spawn = vi.spyOn(Bun, "spawn").mockImplementation((command) => {
      if (!Array.isArray(command)) throw new Error("Expected worker command");
      directory = command.at(-1);
      queueMicrotask(() => emit({ _tag: "WorkspaceWorkerListening" }));
      return child;
    });
    function emit(message: unknown) {
      const options = spawn.mock.calls[0]?.[1];
      if (!options?.ipc) throw new Error("Expected worker IPC callback");
      options.ipc(message, child);
    }

    const outcome = await runBunPromise(
      runDetachedShutdown(
        { operation: "down", worktreePath: result.worktreePath },
        {
          event: (event) =>
            Effect.map(ReporterEvents, (contextEvents) => {
              contextEvents.push(event);
            }).pipe(
              Effect.andThen(
                mode === "failure"
                  ? Effect.fail(
                      commandError("unexpected_error", "reporter failure"),
                    )
                  : mode === "defect"
                    ? Effect.die(new Error("reporter defect"))
                    : mode === "mixed"
                      ? Effect.failCause(
                          Cause.combine(
                            Cause.fail(
                              commandError(
                                "unexpected_error",
                                "reporter failure",
                              ),
                            ),
                            Cause.die(new Error("reporter defect")),
                          ),
                        )
                      : Effect.void,
              ),
            ),
        },
      ).pipe(
        Effect.provideService(ReporterEvents, events),
        Effect.provideService(CurrentWorkspaceLease, lease),
      ),
    );

    expect(outcome).toEqual(result);
    expect(events).toEqual([
      {
        operation: "down",
        _tag: "ShutdownDelegated",
        resultPath: join(directory ?? "", "result.json"),
      },
      phase,
      killed,
    ]);
  },
);

test.each([false, true])(
  "failed shutdown request writes preserve the command error when cleanup fails: %s",
  async (cleanupFails) => {
    const failure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "writeFileString",
    });
    const cleanupFailure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "remove",
    });
    const remove = vi.fn(() =>
      cleanupFails ? Effect.fail(cleanupFailure) : Effect.void,
    );
    const fs = FileSystem.makeNoop({
      realPath: (path) => Effect.succeed(path),
      makeTempDirectory: () => Effect.succeed("/tmp/wct-shutdown-staged"),
      writeFileString: () => Effect.fail(failure),
      remove,
    });
    const result = await runBunPromise(
      runDetachedShutdown({
        operation: "down",
        worktreePath: "/project/worktree",
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.flip),
    );
    expect(result.message).toBe("Failed to prepare independent shutdown");
    expect(result.cause).toBe(failure);
    expect(remove).toHaveBeenCalledExactlyOnceWith("/tmp/wct-shutdown-staged", {
      recursive: true,
      force: true,
    });
  },
);

test("spawn failures remain command errors when staging cleanup fails", async () => {
  const failure = new Error("worker could not start");
  vi.spyOn(Bun, "spawn").mockImplementation(() => {
    throw failure;
  });
  const cleanupFailure = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "remove",
  });
  const remove = vi.fn(() => Effect.fail(cleanupFailure));
  const fs = FileSystem.makeNoop({
    realPath: (path) => Effect.succeed(path),
    makeTempDirectory: () => Effect.succeed("/tmp/wct-shutdown-staged"),
    writeFileString: () => Effect.void,
    remove,
  });
  const result = await runBunPromise(
    runDetachedShutdown({
      operation: "down",
      worktreePath: "/project/worktree",
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(CurrentWorkspaceLease, lease),
      Effect.flip,
    ),
  );
  expect(result.message).toBe("Cannot spawn Workspace worker");
  expect(result.cause).toBe(failure);
  expect(remove).not.toHaveBeenCalled();
});

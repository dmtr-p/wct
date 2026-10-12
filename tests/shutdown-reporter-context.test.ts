import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import {
  runDetachedShutdown,
  type ShutdownMessage,
} from "../src/services/shutdown-runner";
import type {
  WorkspaceDownResult,
  WorkspaceReporterEvent,
} from "../src/services/workspace-service";

const ReporterEvents = Context.Reference<WorkspaceReporterEvent[]>(
  "wct/test/ReporterEvents",
  { defaultValue: () => [] },
);

let directory: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("shutdown IPC reporters inherit caller context and event order", async () => {
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
  const completed: WorkspaceReporterEvent = {
    operation: "down",
    _tag: "AttemptCompleted",
    attempt: "tmux",
    ok: true,
  };
  const child = {
    send: () => {
      emit({ _tag: "Event", event: phase });
      emit({ _tag: "Event", event: completed });
      emit({ _tag: "Completed", outcome: { ok: true, data: result } });
    },
    kill: vi.fn(),
  } as unknown as ReturnType<typeof Bun.spawn>;
  const spawn = vi.spyOn(Bun, "spawn").mockImplementation((command) => {
    if (!Array.isArray(command)) throw new Error("Expected worker command");
    directory = command.at(-1);
    queueMicrotask(() => emit({ _tag: "Ready" }));
    return child;
  });
  function emit(message: ShutdownMessage) {
    const options = spawn.mock.calls[0]?.[1];
    if (!options?.ipc) throw new Error("Expected worker IPC callback");
    options.ipc(message, child);
  }

  const outcome = await Effect.runPromise(
    runDetachedShutdown(
      { operation: "down", worktreePath: result.worktreePath },
      {
        event: (event) =>
          Effect.map(ReporterEvents, (contextEvents) => {
            contextEvents.push(event);
          }),
      },
    ).pipe(Effect.provideService(ReporterEvents, events)),
  );

  expect(outcome).toEqual(result);
  expect(events).toEqual([
    {
      operation: "down",
      _tag: "ShutdownDelegated",
      resultPath: join(directory ?? "", "result.json"),
    },
    phase,
    completed,
  ]);
});

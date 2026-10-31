import { Deferred, Effect, Fiber, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { commandError } from "../../src/errors";
import { RegistrationId } from "../../src/services/identities";
import { makeLocalObservationService } from "../../src/services/local-observation-service";
import { execProcess } from "../../src/services/process";
import {
  liveRegistryService,
  RegistryService,
} from "../../src/services/registry-service";
import { makeTmuxService, TmuxService } from "../../src/services/tmux";
import {
  liveWorktreeService,
  makeWorktreeService,
  WorktreeService,
} from "../../src/services/worktree-service";
import { noopTmuxService } from "./services";

// Exercise the real process collector and captured service contexts with gated children.
export const measureObservationOverlap = Effect.gen(function* () {
  const release = yield* Deferred.make<void>();
  const saturated = yield* Deferred.make<void>();
  let active = 0;
  let peak = 0;
  let started = 0;
  const spawner = ChildProcessSpawner.make(() =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        active++;
        started++;
        peak = Math.max(peak, active);
        if (active === 4) yield* Deferred.succeed(saturated, undefined);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(started),
          exitCode: Deferred.await(release).pipe(
            Effect.as(ChildProcessSpawner.ExitCode(0)),
          ),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
      () =>
        Effect.sync(() => {
          active--;
        }),
    ),
  );
  const read = <A>(value: A) =>
    execProcess("observation-fixture").pipe(
      Effect.mapError((error) =>
        commandError("unexpected_error", error.message, error),
      ),
      Effect.as(value),
    );
  const trees = Array.from({ length: 8 }, (_, index) => ({
    branch: "branch-" + index,
    path: "/tmp",
    isBare: false,
    commit: "abc",
  }));
  const worktree = yield* makeWorktreeService({
    ...liveWorktreeService,
    listWorktrees: () => read(trees),
    getDefaultBranch: () => read("main"),
    getChangedFileCount: () => read(0),
    getAheadBehind: () => read(null),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const tmux = yield* makeTmuxService({
    ...noopTmuxService,
    listSessions: read(
      Array.from({ length: 12 }, (_, index) => ({
        name: String(index),
        attached: false,
        windows: 1,
      })),
    ),
    listPanes: () => read([]),
    listClients: read([]),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const service = yield* makeLocalObservationService.pipe(
    Effect.provideService(RegistryService, {
      ...liveRegistryService,
      listRepos: Effect.succeed(
        Array.from({ length: 6 }, (_, index) => ({
          id: RegistrationId(String(index)),
          repo_path: "/tmp",
          project: String(index),
          created_at: 0,
        })),
      ),
    }),
    Effect.provideService(WorktreeService, worktree),
    Effect.provideService(TmuxService, tmux),
  );
  const cancelled = yield* Effect.forkChild(service.repositories);
  yield* Deferred.await(saturated);
  const surviving = yield* Effect.forkChild(service.repositories);
  const sessions = yield* Effect.forkChild(service.sessions);
  const queued = yield* Effect.forkChild(service.clients, {
    startImmediately: true,
  });
  yield* Fiber.interrupt(queued);
  const startedBeforeCancellation = started;
  yield* Fiber.interrupt(cancelled);
  yield* Deferred.succeed(release, undefined);
  const repos = yield* Fiber.join(surviving);
  const snapshot = yield* Fiber.join(sessions);
  yield* service.clients;
  return {
    peak,
    active,
    startedBeforeCancellation,
    repositories: repos.length,
    sessions: snapshot.sessions.length,
  };
});

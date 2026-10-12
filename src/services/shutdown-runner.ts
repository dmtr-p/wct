import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import type { ResolvedConfig } from "../config/schema";
import { commandError, toWctError, type WctError } from "../errors";
import type { WctEnv } from "../types/env";
import type {
  WorkspaceCloseResult,
  WorkspaceDownResult,
  WorkspaceReporter,
  WorkspaceReporterEvent,
} from "./workspace-service";

export const SHUTDOWN_WORKER_FLAG = "--wct-shutdown-worker";

export interface ShutdownRequest {
  operation: "down" | "close";
  worktreePath: string;
  shutdown?: { config: ResolvedConfig; env: WctEnv };
  cwd?: string;
  force?: boolean;
  retryWithForce?: boolean;
}

export type ShutdownResult = WorkspaceDownResult | WorkspaceCloseResult;
export type ShutdownOutcome =
  | { ok: true; data: ShutdownResult }
  | { ok: false; error: { code: WctError["code"]; message: string } };

export type ShutdownMessage =
  | { _tag: "Ready" }
  | { _tag: "Event"; event: WorkspaceReporterEvent }
  | { _tag: "Completed"; outcome: ShutdownOutcome };

export function shutdownWorkerCommand(directory: string) {
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  // Compiled Bun executables contain source paths in the virtual $bunfs tree.
  return entry.startsWith("/$bunfs/")
    ? [process.execPath, SHUTDOWN_WORKER_FLAG, directory]
    : [process.execPath, "run", entry, SHUTDOWN_WORKER_FLAG, directory];
}

async function createShutdownDirectory(worktreePath: string) {
  const worktreeRoot = await realpath(worktreePath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  let lastError: unknown;
  // TMPDIR can point into the checkout, including through a symlink.
  for (const candidate of new Set([tmpdir(), "/tmp", "/var/tmp"])) {
    try {
      const stagingRoot = await realpath(candidate);
      if (worktreeRoot) {
        const path = relative(worktreeRoot, stagingRoot);
        if (
          path === "" ||
          (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
        )
          continue;
      }
      return await mkdtemp(join(stagingRoot, "wct-shutdown-"));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Cannot stage shutdown outside the target worktree", {
    cause: lastError,
  });
}

export function runDetachedShutdown(
  request: ShutdownRequest,
  reporter?: WorkspaceReporter,
) {
  return Effect.gen(function* () {
    const context = yield* Effect.context();
    const directory = yield* Effect.tryPromise({
      try: async () => {
        const directory = await createShutdownDirectory(request.worktreePath);
        try {
          await Bun.write(
            join(directory, "request.json"),
            JSON.stringify(request),
          );
          return directory;
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          throw error;
        }
      },
      catch: (error) =>
        commandError(
          "unexpected_error",
          "Failed to prepare independent shutdown",
          error,
        ),
    });
    const resultPath = join(directory, "result.json");
    const ready = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<ShutdownOutcome>();
    // A startup failure can reject both promises before the second is awaited.
    void completed.promise.catch(() => undefined);
    let events = Promise.resolve();
    let started = false;
    const child = yield* Effect.try({
      try: () =>
        Bun.spawn(shutdownWorkerCommand(directory), {
          cwd: request.shutdown?.env.WCT_MAIN_DIR ?? request.cwd,
          env: { ...process.env },
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          ipc: (message: ShutdownMessage) => {
            if (message._tag === "Ready") ready.resolve();
            else if (message._tag === "Completed")
              completed.resolve(message.outcome);
            else if (message._tag === "Event" && reporter) {
              events = events.then(() =>
                Effect.runPromiseWith(context)(
                  Effect.suspend(() => reporter.event(message.event)).pipe(
                    Effect.ignoreCause,
                  ),
                ),
              );
            }
          },
          onExit: async (_child, code, signal, error) => {
            const failure = commandError(
              "unexpected_error",
              `Independent shutdown exited before returning a result (${error?.message ?? signal ?? code}); inspect ${resultPath}`,
            );
            ready.reject(failure);
            // A final IPC message may race process exit; the saved outcome is authoritative.
            try {
              completed.resolve(
                JSON.parse(
                  await Bun.file(resultPath).text(),
                ) as ShutdownOutcome,
              );
            } catch {
              completed.reject(failure);
            }
          },
        }),
      catch: (error) =>
        commandError(
          "unexpected_error",
          "Failed to start independent shutdown",
          error,
        ),
    }).pipe(
      Effect.onError(() =>
        Effect.promise(() => rm(directory, { recursive: true, force: true })),
      ),
    );
    yield* Effect.tryPromise({
      try: () => ready.promise,
      catch: toWctError,
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((error) =>
        commandError(
          "unexpected_error",
          "Independent shutdown did not become ready",
          error,
        ),
      ),
      Effect.onError(() =>
        Effect.sync(() => {
          if (!started) child.kill();
        }),
      ),
    );
    // The worker cannot kill the pane until its caller has announced the handoff.
    if (reporter) {
      yield* Effect.suspend(() =>
        reporter.event({
          operation: request.operation,
          _tag: "ShutdownDelegated",
          resultPath,
        }),
      ).pipe(Effect.ignoreCause);
    }
    yield* Effect.try({
      try: () => {
        child.send({ _tag: "Start" });
        started = true;
      },
      catch: (error) =>
        commandError("unexpected_error", "Failed to hand off shutdown", error),
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          if (!started) child.kill();
        }),
      ),
    );
    // Once committed, cancellation or loss of the caller must not kill cleanup.
    const outcome = yield* Effect.tryPromise({
      try: () => completed.promise,
      catch: (error) =>
        commandError(
          "unexpected_error",
          `Independent shutdown failed; inspect ${resultPath}`,
          error,
        ),
    });
    yield* Effect.promise(() => events);
    if (!outcome.ok) {
      return yield* commandError(
        outcome.error.code,
        `${outcome.error.message} (shutdown result: ${resultPath})`,
      );
    }
    return outcome.data;
  });
}

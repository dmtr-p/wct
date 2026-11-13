import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Result } from "effect";
import type { ResolvedConfig } from "../config/schema";
import { commandError, type WctError } from "../errors";
import type { WctEnv } from "../types/env";
import { processEnvironment } from "./process";
import type {
  WorkspaceSession,
  WorkspaceSessionTarget,
} from "./session-identity";
import { CurrentWorkspaceLease } from "./workspace-coordination";
import type {
  WorkspaceCloseResult,
  WorkspaceDownResult,
  WorkspaceReporter,
  WorkspaceReporterEvent,
} from "./workspace-service";
import type { WorkspaceTargetEvidence } from "./workspace-target";
import { transferWorkspaceToWorker } from "./workspace-transfer";

export const SHUTDOWN_WORKER_FLAG = "--wct-shutdown-worker";

export interface ShutdownRequest {
  targetEvidence?: WorkspaceTargetEvidence;
  sessionTarget?: WorkspaceSessionTarget;
  session?: WorkspaceSession | null;
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
  | { _tag: "Event"; event: WorkspaceReporterEvent }
  | { _tag: "Completed"; outcome: ShutdownOutcome };

export function shutdownWorkerCommand(directory: string) {
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  // Compiled Bun executables contain source paths in the virtual $bunfs tree.
  return entry.startsWith("/$bunfs/")
    ? [process.execPath, SHUTDOWN_WORKER_FLAG, directory]
    : [process.execPath, "run", entry, SHUTDOWN_WORKER_FLAG, directory];
}

function createShutdownDirectory(worktreePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const worktreeRoot = yield* fs.realPath(worktreePath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
    let lastError: unknown;
    // TMPDIR can point into the checkout, including through a symlink.
    for (const candidate of new Set([tmpdir(), "/tmp", "/var/tmp"])) {
      const stagingRoot = yield* Effect.result(fs.realPath(candidate));
      if (Result.isFailure(stagingRoot)) {
        lastError = stagingRoot.failure;
        continue;
      }
      if (worktreeRoot) {
        const path = relative(worktreeRoot, stagingRoot.success);
        if (
          path === "" ||
          (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
        )
          continue;
      }
      // The worker owns cleanup after handoff, beyond the caller's scope.
      const directory = yield* Effect.result(
        fs.makeTempDirectory({
          directory: stagingRoot.success,
          prefix: "wct-shutdown-",
        }),
      );
      if (Result.isSuccess(directory)) return directory.success;
      lastError = directory.failure;
    }
    return yield* commandError(
      "unexpected_error",
      "Cannot stage shutdown outside the target worktree",
      lastError,
    );
  });
}

export function runDetachedShutdown(
  request: ShutdownRequest,
  reporter?: WorkspaceReporter,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const context = yield* Effect.context();
    const directory = yield* Effect.gen(function* () {
      const directory = yield* createShutdownDirectory(request.worktreePath);
      yield* Effect.try(() => JSON.stringify(request)).pipe(
        Effect.flatMap((content) =>
          fs.writeFileString(join(directory, "request.json"), content),
        ),
        Effect.onError(() =>
          fs
            .remove(directory, { recursive: true, force: true })
            .pipe(Effect.ignore),
        ),
      );
      return directory;
    }).pipe(
      Effect.mapError((error) =>
        commandError(
          "unexpected_error",
          "Failed to prepare independent shutdown",
          error,
        ),
      ),
    );
    const resultPath = join(directory, "result.json");
    const lease = yield* CurrentWorkspaceLease;
    if (!lease)
      return yield* commandError(
        "workspace_coordination_error",
        "Independent shutdown requires current Workspace custody",
      );
    const completed = Promise.withResolvers<ShutdownOutcome>();
    void completed.promise.catch(() => undefined);
    let events = Promise.resolve();
    const env = yield* processEnvironment;
    const child = yield* transferWorkspaceToWorker(
      lease,
      shutdownWorkerCommand(directory),
      {
        cwd: request.shutdown?.env.WCT_MAIN_DIR ?? request.cwd,
        env,
        beforeStart: reporter
          ? Effect.suspend(() =>
              reporter.event({
                operation: request.operation,
                _tag: "ShutdownDelegated",
                resultPath,
              }),
            ).pipe(Effect.ignoreCause)
          : Effect.void,
        onMessage: (message) => {
          if (!message || typeof message !== "object" || !("_tag" in message))
            return;
          const shutdown = message as ShutdownMessage;
          if (shutdown._tag === "Completed")
            completed.resolve(shutdown.outcome);
          else if (shutdown._tag === "Event" && reporter) {
            events = events.then(() =>
              Effect.runPromiseWith(context)(
                Effect.suspend(() => reporter.event(shutdown.event)).pipe(
                  Effect.ignoreCause,
                ),
              ),
            );
          }
        },
        onExit: () => {
          // The persisted result is authoritative if final IPC races process exit.
          void Effect.runPromiseWith(context)(fs.readFileString(resultPath))
            .then((content) =>
              completed.resolve(JSON.parse(content) as ShutdownOutcome),
            )
            .catch(() =>
              completed.reject(
                commandError(
                  "workspace_coordination_error",
                  `Independent shutdown exited without an outcome; inspect ${resultPath} and Workspace ownership before retrying`,
                ),
              ),
            );
        },
      },
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
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (child) {
            try {
              child.disconnect();
            } catch {
              /* Already disconnected. */
            }
            child.unref();
          }
        }),
      ),
    );
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

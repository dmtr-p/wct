import { resolve } from "node:path";
import { Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";
import { commandError, toWctError } from "../errors";
import { processEnvironment } from "../services/process";
import {
  canonicalSessionTarget,
  ownsWorkspaceSession,
} from "../services/session-identity";
import { TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";

export function browserCommand(options: {
  path?: string;
  branch?: string;
  port?: string;
}) {
  return Effect.suspend(() => {
    // A raw PTY write cannot compare the session when tmux consumes each key.
    // Keep CLI launch closed until an adapter can preserve the full keyboard
    // interface and enforce the required per-session input fence together.
    if (!strictSessionInputAvailable())
      return Effect.fail(
        commandError(
          "tmux_error",
          "Browser terminal unavailable: strict per-session input fencing with the full tmux keyboard interface requires additional tmux adapter support",
        ),
      );
    return startBrowserCommand(options);
  });
}

function strictSessionInputAvailable(): boolean {
  return false;
}

function startBrowserCommand(options: {
  path?: string;
  branch?: string;
  port?: string;
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      if (yield* JsonFlag)
        return yield* commandError(
          "invalid_options",
          "The foreground browser terminal requires human output",
        );
      const worktree = yield* WorktreeService;
      const tmux = yield* TmuxService;
      const path = options.path
        ? resolve(options.path)
        : options.branch
          ? (yield* worktree.findWorktreeByBranch(options.branch))?.path
          : process.cwd();
      if (!path)
        return yield* commandError(
          "worktree_not_found",
          "No worktree found for the selected branch",
        );
      const root = yield* worktree.getWorktreeRoot(path);
      const mainRepoPath = yield* worktree.getMainRepoPath(root);
      if (!mainRepoPath)
        return yield* commandError(
          "worktree_error",
          "Cannot determine Main Repository",
        );
      const target = yield* canonicalSessionTarget({
        mainRepoPath,
        worktreePath: root,
        branch: (yield* worktree.getCurrentBranch(root)) ?? "",
      });
      const session = yield* tmux.resolveSession(target, undefined, {
        readOnly: true,
      });
      if (
        !session?.id ||
        !session.server ||
        !ownsWorkspaceSession(session, target)
      )
        return yield* commandError(
          "tmux_error",
          "An existing verified Workspace Session is required; start it with wct up",
        );
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);
      const env = yield* processEnvironment;
      const { startLocalTerminal } = yield* Effect.tryPromise({
        try: () => import("../browser/server"),
        catch: (error) => toWctError(error, "Cannot load browser terminal"),
      });
      const endpoint = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            startLocalTerminal({
              port: options.port === undefined ? 0 : Number(options.port),
              env,
              diagnostic: (message) => {
                process.stderr.write(`${message}\n`);
              },
              backend: {
                prepare: () =>
                  // A deadline must not interrupt reservation acquisition after
                  // tmux writes its record but before we receive its handle.
                  run(tmux.prepareAttachment(target, "browser")),
                query: (ref) =>
                  run(
                    tmux.queryAttachment(ref).pipe(Effect.timeout("2 seconds")),
                  ),
                detach: (ref) =>
                  run(
                    tmux
                      .detachAttachment(ref)
                      .pipe(Effect.timeout("2 seconds")),
                  ),
                verify: async (client) => {
                  const current = await run(
                    tmux
                      .resolveSession(target, session, { readOnly: true })
                      .pipe(Effect.timeout("2 seconds")),
                  );
                  if (
                    !current?.id ||
                    !current.server ||
                    !ownsWorkspaceSession(current, target) ||
                    current.id !== session.id ||
                    current.server !== session.server ||
                    client.sessionId !== current.id ||
                    client.server !== current.server
                  )
                    throw new Error("Workspace Session changed");
                  return {
                    ...target,
                    server: current.server,
                    sessionId: current.id,
                  };
                },
              },
            }),
          catch: (error) => toWctError(error, "Cannot start browser terminal"),
        }),
        (endpoint) => Effect.promise(() => endpoint.stop()),
      );
      yield* logger.info(`Open ${endpoint.bootstrapUrl}`);
      yield* logger.info(
        "Foreground local terminal; Ctrl-C disconnects browser clients and leaves Workspace workloads running.",
      );
      return yield* Effect.never;
    }),
  );
}

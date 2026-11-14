import { resolve } from "node:path";
import { Effect } from "effect";
import { type LocalTarget, sameLocalTarget } from "../browser/protocol";
import { inspectLocalTarget } from "../browser/target";
import { JsonFlag } from "../cli/json-flag";
import type { BunServices } from "../effect/runtime";
import { commandError, toWctError } from "../errors";
import { processEnvironment } from "../services/process";
import {
  canonicalSessionTarget,
  ownsWorkspaceSession,
} from "../services/session-identity";
import {
  prepareSessionAttachment,
  type TmuxClient,
} from "../services/terminal-attachments";
import { TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";

export function browserCommand(options: {
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
      const context = yield* Effect.context<BunServices.BunServices>();
      const run = Effect.runPromiseWith(context);
      const env = yield* processEnvironment;
      const { startLocalTerminal } = yield* Effect.tryPromise({
        try: () => import("../browser/server"),
        catch: (error) => toWctError(error, "Cannot load browser terminal"),
      });
      const initial = {
        ...target,
        server: session.server,
        sessionId: session.id,
      };
      const inspect = (client: TmuxClient) =>
        inspectLocalTarget(client, {
          initial,
          sessions: () =>
            run(tmux.listSessions.pipe(Effect.timeout("2 seconds"))),
          canonical: (target) => run(canonicalSessionTarget(target)),
          worktrees: (path) =>
            run(worktree.listWorktrees(path).pipe(Effect.timeout("2 seconds"))),
          root: (path) =>
            run(
              worktree.getWorktreeRoot(path).pipe(Effect.timeout("2 seconds")),
            ),
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
                prepare: async (expected) => {
                  // Preparation is never interrupted after reserving a tmux record.
                  // Recovery names the exact observed session, including native navigation.
                  const selected: LocalTarget = expected ?? initial;
                  const current = await inspect({
                    tty: "",
                    session: "",
                    server: selected.server,
                    sessionId: selected.sessionId,
                  });
                  if (!sameLocalTarget(current, selected))
                    throw new Error("Recovery target changed");
                  return {
                    ...(await run(
                      prepareSessionAttachment(
                        { id: selected.sessionId, server: selected.server },
                        "browser",
                      ),
                    )),
                    target: selected,
                  };
                },
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
                verify: inspect,
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

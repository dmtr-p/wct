import { Effect } from "effect";
import {
  makeWctServicesLayer,
  type WctServiceOverrides,
} from "../../src/effect/services";
import type { TmuxService as TmuxServiceApi } from "../../src/services/tmux";
import {
  liveWorktreeService,
  type WorktreeServiceImplementation as WorktreeServiceApi,
} from "../../src/services/worktree-service";

export { legacySession } from "./session-projections";

export const shutdownWorktreeService: WorktreeServiceApi = {
  ...liveWorktreeService,
  getWorktreeRoot: (cwd) => Effect.succeed(cwd),
  getMainRepoPath: () => Effect.succeed("/tmp/wct-test-main"),
  getCurrentBranch: () => Effect.succeed("feature"),
};

export type ServiceOverrides = WctServiceOverrides;

export const noopTmuxService: TmuxServiceApi = {
  listSessions: Effect.succeed(null),
  resolveSession: () => Effect.succeed(null),
  sessionExists: () => Effect.succeed(false),
  createSession: (_name, _workingDir) =>
    Effect.succeed({ _tag: "Created", sessionName: _name }),
  killSession: () => Effect.void,
  getCurrentSession: Effect.succeed(null),
  switchSession: () => Effect.void,
  attachSession: () => Effect.void,
  listPanes: () => Effect.succeed([]),
  listClients: Effect.succeed([]),
  prepareAttachment: () =>
    Effect.die(new Error("Attachment launch is not configured")),
  queryAttachment: () => Effect.succeed(null),
  switchAttachment: () => Effect.succeed(null),
  detachAttachment: () => Effect.void,
  detachClient: () => Effect.void,
  switchClientToPane: () => Effect.void,
  togglePaneZoom: () => Effect.void,
  killPane: () => Effect.void,
};

export function withTestServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  overrides: ServiceOverrides = {},
) {
  const tmux = overrides.tmux ?? noopTmuxService;
  const killed = new Set<string>();
  const identities = new Map<string, string>();
  return Effect.provide(
    effect,
    makeWctServicesLayer({
      ...overrides,
      tmux: {
        ...tmux,
        resolveSession: (...args) =>
          tmux.resolveSession(...args).pipe(
            Effect.map((session) => {
              if (session?.id)
                identities.set(
                  session.id,
                  JSON.stringify([session.id, session.server]),
                );
              return session &&
                killed.has(JSON.stringify([session.id, session.server]))
                ? null
                : session;
            }),
          ),
        killSession: (id) =>
          tmux.killSession(id).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                const identity = identities.get(id);
                if (identity) killed.add(identity);
              }),
            ),
          ),
      },
    }),
  );
}

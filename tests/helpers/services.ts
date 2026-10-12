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

export const shutdownWorktreeService: WorktreeServiceApi = {
  ...liveWorktreeService,
  getWorktreeRoot: (cwd) => Effect.succeed(cwd),
  getMainRepoPath: () => Effect.succeed("/tmp/wct-test-main"),
  getCurrentBranch: () => Effect.succeed("feature"),
};

export type ServiceOverrides = WctServiceOverrides;

/**
 * No-op TmuxService that never calls real tmux.
 * Used as the default in tests to prevent side-effects on the host machine.
 */
export const noopTmuxService: TmuxServiceApi = {
  listSessions: Effect.succeed(null),
  isPaneAlive: () => Effect.succeed(null),
  sessionExists: () => Effect.succeed(false),
  getSessionStatus: () => Effect.succeed(null),
  createSession: (_name, _workingDir) =>
    Effect.succeed({ _tag: "Created", sessionName: _name }),
  killSession: () => Effect.void,
  getCurrentSession: Effect.succeed(null),
  switchSession: () => Effect.void,
  attachSession: () => Effect.void,
  listPanes: () => Effect.succeed([]),
  listClients: Effect.succeed([]),
  detachClient: () => Effect.void,
  switchClientToPane: () => Effect.void,
  selectPane: () => Effect.void,
  togglePaneZoom: () => Effect.void,
  killPane: () => Effect.void,
  refreshClient: Effect.void,
};

export function withTestServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  overrides: ServiceOverrides = {},
) {
  return Effect.provide(
    effect,
    makeWctServicesLayer({ tmux: noopTmuxService, ...overrides }),
  );
}

import { Effect } from "effect";
import { JsonFlag } from "../../src/cli/json-flag";
import type { WctServices } from "../../src/effect/services";
import {
  GitHubService,
  type GitHubService as GitHubServiceApi,
  liveGitHubService,
} from "../../src/services/github-service";
import {
  IdeService,
  type IdeService as IdeServiceApi,
  liveIdeService,
} from "../../src/services/ide-service";
import {
  livePrCacheService,
  PrCacheService,
  type PrCacheServiceApi,
} from "../../src/services/pr-cache-service";
import {
  liveRegistryService,
  RegistryService,
  type RegistryServiceApi,
} from "../../src/services/registry-service";
import {
  liveSetupService,
  SetupService,
  type SetupService as SetupServiceApi,
} from "../../src/services/setup-service";
import {
  TmuxService,
  type TmuxService as TmuxServiceApi,
} from "../../src/services/tmux";
import {
  liveVSCodeWorkspaceService,
  VSCodeWorkspaceService,
  type VSCodeWorkspaceService as VSCodeWorkspaceServiceApi,
} from "../../src/services/vscode-workspace";
import {
  liveWorkspaceService,
  WorkspaceService,
  type WorkspaceService as WorkspaceServiceApi,
} from "../../src/services/workspace-service";
import {
  liveWorktreeService,
  WorktreeService,
  type WorktreeService as WorktreeServiceApi,
} from "../../src/services/worktree-service";

type JsonFlagRequirement = "effect/unstable/cli/GlobalFlag/json";

export interface ServiceOverrides {
  github?: GitHubServiceApi;
  ide?: IdeServiceApi;
  json?: boolean;
  prCache?: PrCacheServiceApi;
  registry?: RegistryServiceApi;
  setup?: SetupServiceApi;
  tmux?: TmuxServiceApi;
  vscodeWorkspace?: VSCodeWorkspaceServiceApi;
  worktree?: WorktreeServiceApi;
  workspace?: WorkspaceServiceApi;
}

/**
 * No-op TmuxService that never calls real tmux.
 * Used as the default in tests to prevent side-effects on the host machine.
 */
export const noopTmuxService: TmuxServiceApi = {
  listSessions: () => Effect.succeed(null),
  isPaneAlive: () => Effect.succeed(null),
  sessionExists: () => Effect.succeed(false),
  getSessionStatus: () => Effect.succeed(null),
  createSession: (_name, _workingDir) =>
    Effect.succeed({ _tag: "Created", sessionName: _name }),
  killSession: () => Effect.void,
  getCurrentSession: () => Effect.succeed(null),
  switchSession: () => Effect.void,
  attachSession: () => Effect.void,
  listPanes: () => Effect.succeed([]),
  listClients: () => Effect.succeed([]),
  detachClient: () => Effect.void,
  switchClientToPane: () => Effect.void,
  selectPane: () => Effect.void,
  togglePaneZoom: () => Effect.void,
  killPane: () => Effect.void,
  refreshClient: () => Effect.void,
};

export function withTestServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  overrides: ServiceOverrides = {},
): Effect.Effect<A, E, Exclude<R, WctServices | JsonFlagRequirement>> {
  let provided = effect;

  provided = Effect.provideService(
    provided,
    GitHubService,
    overrides.github ?? liveGitHubService,
  );
  provided = Effect.provideService(
    provided,
    IdeService,
    overrides.ide ?? liveIdeService,
  );
  provided = Effect.provideService(
    provided,
    SetupService,
    overrides.setup ?? liveSetupService,
  );
  provided = Effect.provideService(
    provided,
    TmuxService,
    overrides.tmux ?? noopTmuxService,
  );
  provided = Effect.provideService(
    provided,
    VSCodeWorkspaceService,
    overrides.vscodeWorkspace ?? liveVSCodeWorkspaceService,
  );
  provided = Effect.provideService(
    provided,
    WorktreeService,
    overrides.worktree ?? liveWorktreeService,
  );
  provided = Effect.provideService(
    provided,
    WorkspaceService,
    overrides.workspace ?? liveWorkspaceService,
  );
  provided = Effect.provideService(
    provided,
    PrCacheService,
    overrides.prCache ?? livePrCacheService,
  );
  provided = Effect.provideService(
    provided,
    RegistryService,
    overrides.registry ?? liveRegistryService,
  );
  provided = Effect.provideService(provided, JsonFlag, overrides.json ?? false);

  return provided as Effect.Effect<
    A,
    E,
    Exclude<R, WctServices | JsonFlagRequirement>
  >;
}

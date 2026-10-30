import type { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { JsonFlag } from "../cli/json-flag";
import {
  GitHubService,
  type GitHubService as GitHubServiceApi,
  type GitHubServiceImplementation,
  makeGitHubService,
} from "../services/github-service";
import {
  livePrCacheService,
  PrCacheService,
  type PrCacheServiceApi,
} from "../services/pr-cache-service";
import {
  makePrRefreshService,
  PrRefreshService,
  type PrRefreshServiceApi,
} from "../services/pr-refresh-service";
import {
  liveRegistryService,
  RegistryService,
  type RegistryServiceApi,
} from "../services/registry-service";
import {
  makeSetupService,
  SetupService,
  type SetupService as SetupServiceApi,
  type SetupServiceImplementation,
} from "../services/setup-service";
import {
  makeTmuxService,
  TmuxService,
  type TmuxService as TmuxServiceApi,
  type TmuxServiceImplementation,
} from "../services/tmux";
import {
  makeWorkspaceService,
  WorkspaceService,
  type WorkspaceService as WorkspaceServiceApi,
  type WorkspaceServiceImplementation,
} from "../services/workspace-service";
import {
  makeWorktreeService,
  WorktreeService,
  type WorktreeService as WorktreeServiceApi,
  type WorktreeServiceImplementation,
} from "../services/worktree-service";

export type WctServices =
  | BunServices.BunServices
  | GitHubServiceApi
  | PrRefreshServiceApi
  | PrCacheServiceApi
  | RegistryServiceApi
  | SetupServiceApi
  | TmuxServiceApi
  | WorktreeServiceApi
  | WorkspaceServiceApi;

export interface WctServiceOverrides {
  github?: GitHubServiceImplementation;
  json?: boolean;
  prCache?: PrCacheServiceApi;
  prRefresh?: PrRefreshServiceApi;
  registry?: RegistryServiceApi;
  setup?: SetupServiceImplementation;
  tmux?: TmuxServiceImplementation;
  worktree?: WorktreeServiceImplementation;
  workspace?: WorkspaceServiceImplementation;
}

export function makeWctServicesLayer(overrides: WctServiceOverrides = {}) {
  const dependencies = Layer.mergeAll(
    Layer.effect(GitHubService, makeGitHubService(overrides.github)),
    Layer.succeed(PrCacheService, overrides.prCache ?? livePrCacheService),
    Layer.effect(SetupService, makeSetupService(overrides.setup)),
    Layer.effect(TmuxService, makeTmuxService(overrides.tmux)),
    Layer.effect(WorktreeService, makeWorktreeService(overrides.worktree)),
    Layer.succeed(RegistryService, overrides.registry ?? liveRegistryService),
    Layer.succeed(JsonFlag, overrides.json ?? false),
  );
  return Layer.mergeAll(
    Layer.effect(WorkspaceService, makeWorkspaceService(overrides.workspace)),
    overrides.prRefresh
      ? Layer.succeed(PrRefreshService, overrides.prRefresh)
      : Layer.effect(PrRefreshService, makePrRefreshService),
  ).pipe(Layer.provideMerge(dependencies));
}

// Platform services must be supplied when building the application layers.
export const WctServicesLayer = makeWctServicesLayer();

export function provideWctServices<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.provide(effect, WctServicesLayer);
}

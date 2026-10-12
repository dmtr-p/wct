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
  liveRegistryService,
  RegistryService,
  type RegistryServiceApi,
} from "../services/registry-service";
import {
  liveSetupService,
  SetupService,
  type SetupService as SetupServiceApi,
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
  registry?: RegistryServiceApi;
  setup?: SetupServiceApi;
  tmux?: TmuxServiceImplementation;
  worktree?: WorktreeServiceImplementation;
  workspace?: WorkspaceServiceImplementation;
}

export function makeWctServicesLayer(overrides: WctServiceOverrides = {}) {
  const dependencies = Layer.mergeAll(
    Layer.effect(GitHubService, makeGitHubService(overrides.github)),
    Layer.succeed(PrCacheService, overrides.prCache ?? livePrCacheService),
    Layer.succeed(SetupService, overrides.setup ?? liveSetupService),
    Layer.effect(TmuxService, makeTmuxService(overrides.tmux)),
    Layer.effect(WorktreeService, makeWorktreeService(overrides.worktree)),
    Layer.succeed(RegistryService, overrides.registry ?? liveRegistryService),
    Layer.succeed(JsonFlag, overrides.json ?? false),
  );
  return Layer.effect(
    WorkspaceService,
    makeWorkspaceService(overrides.workspace),
  ).pipe(Layer.provideMerge(dependencies));
}

// Platform services must be supplied when building the application layers.
export const WctServicesLayer = makeWctServicesLayer();

export function provideWctServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E,
  | Exclude<R, WctServices | "effect/cli/GlobalFlag/json">
  | BunServices.BunServices
> {
  return Effect.provide(effect, WctServicesLayer) as Effect.Effect<
    A,
    E,
    | Exclude<R, WctServices | "effect/cli/GlobalFlag/json">
    | BunServices.BunServices
  >;
}

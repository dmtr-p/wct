import type { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { JsonFlag } from "../cli/json-flag";
import {
  GitHubService,
  type GitHubService as GitHubServiceApi,
  liveGitHubService,
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
  liveTmuxService,
  TmuxService,
  type TmuxService as TmuxServiceApi,
} from "../services/tmux";
import {
  liveWorkspaceService,
  WorkspaceService,
  type WorkspaceService as WorkspaceServiceApi,
} from "../services/workspace-service";
import {
  liveWorktreeService,
  WorktreeService,
  type WorktreeService as WorktreeServiceApi,
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

/**
 * Layer providing every live wct service plus the default `JsonFlag` value.
 * Does NOT include `BunServices.layer`; that is provided separately by
 * `provideBunServices` in `runtime.ts` so live tests can compose them
 * independently. The `ROut` is the union of every wct service tag plus
 * `JsonFlag`.
 */
export const WctServicesLayer = Layer.mergeAll(
  Layer.succeed(GitHubService, liveGitHubService),
  Layer.succeed(PrCacheService, livePrCacheService),
  Layer.succeed(SetupService, liveSetupService),
  Layer.succeed(TmuxService, liveTmuxService),
  Layer.succeed(WorktreeService, liveWorktreeService),
  Layer.succeed(WorkspaceService, liveWorkspaceService),
  Layer.succeed(RegistryService, liveRegistryService),
  Layer.succeed(JsonFlag, false),
);

export function provideWctServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E,
  Exclude<R, WctServices | "effect/unstable/cli/GlobalFlag/json">
> {
  return Effect.provide(effect, WctServicesLayer) as Effect.Effect<
    A,
    E,
    Exclude<R, WctServices | "effect/unstable/cli/GlobalFlag/json">
  >;
}

import type { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { JsonFlag } from "../cli/json-flag";
import {
  GitHubService,
  type GitHubService as GitHubServiceApi,
  liveGitHubService,
} from "../services/github-service";
import {
  IdeService,
  type IdeService as IdeServiceApi,
  liveIdeService,
} from "../services/ide-service";
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
  liveVSCodeWorkspaceService,
  VSCodeWorkspaceService,
  type VSCodeWorkspaceService as VSCodeWorkspaceServiceApi,
} from "../services/vscode-workspace";
import {
  liveWorktreeService,
  WorktreeService,
  type WorktreeService as WorktreeServiceApi,
} from "../services/worktree-service";

export type WctServices =
  | BunServices.BunServices
  | GitHubServiceApi
  | IdeServiceApi
  | RegistryServiceApi
  | SetupServiceApi
  | TmuxServiceApi
  | VSCodeWorkspaceServiceApi
  | WorktreeServiceApi;

export type WctRuntimeServices =
  | BunServices.BunServices
  | GitHubServiceApi
  | RegistryServiceApi
  | TmuxServiceApi
  | WorktreeServiceApi;

/**
 * Layer providing every live wct service plus the default `JsonFlag` value.
 * Does NOT include `BunServices.layer`; that is provided separately by
 * `provideBunServices` in `runtime.ts` so live tests can compose them
 * independently. The `ROut` is the union of every wct service tag plus
 * `JsonFlag`.
 */
export const WctServicesLayer = Layer.mergeAll(
  Layer.succeed(GitHubService, liveGitHubService),
  Layer.succeed(IdeService, liveIdeService),
  Layer.succeed(SetupService, liveSetupService),
  Layer.succeed(TmuxService, liveTmuxService),
  Layer.succeed(VSCodeWorkspaceService, liveVSCodeWorkspaceService),
  Layer.succeed(WorktreeService, liveWorktreeService),
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

import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import {
  GitHubService,
  type GitHubService as GitHubServiceApi,
  liveGitHubService,
} from "../services/github-service";
import {
  HooksService,
  type HooksService as HooksServiceApi,
  liveHooksService,
} from "../services/hooks-service";
import {
  IdeService,
  type IdeService as IdeServiceApi,
  liveIdeService,
} from "../services/ide-service";
import {
  liveQueueStorage,
  QueueStorage,
  type QueueStorageService,
} from "../services/queue-storage";
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
  | HooksServiceApi
  | IdeServiceApi
  | QueueStorageService
  | RegistryServiceApi
  | SetupServiceApi
  | TmuxServiceApi
  | VSCodeWorkspaceServiceApi
  | WorktreeServiceApi;

export type WctRuntimeServices =
  | BunServices.BunServices
  | GitHubServiceApi
  | QueueStorageService
  | RegistryServiceApi
  | TmuxServiceApi
  | WorktreeServiceApi;

export function provideWctServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, WctServices>> {
  return Effect.provideService(
    Effect.provideService(
      Effect.provideService(
        Effect.provideService(
          Effect.provideService(
            Effect.provideService(
              Effect.provideService(
                Effect.provideService(
                  Effect.provideService(
                    effect,
                    GitHubService,
                    liveGitHubService,
                  ),
                  HooksService,
                  liveHooksService,
                ),
                IdeService,
                liveIdeService,
              ),
              QueueStorage,
              liveQueueStorage,
            ),
            SetupService,
            liveSetupService,
          ),
          TmuxService,
          liveTmuxService,
        ),
        VSCodeWorkspaceService,
        liveVSCodeWorkspaceService,
      ),
      WorktreeService,
      liveWorktreeService,
    ),
    RegistryService,
    liveRegistryService,
  ) as Effect.Effect<A, E, Exclude<R, WctServices>>;
}

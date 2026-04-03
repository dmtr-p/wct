import { Effect } from "effect";
import { JsonFlag } from "../../src/cli/json-flag";
import type { WctServices } from "../../src/effect/services";
import {
  GitHubService,
  type GitHubService as GitHubServiceApi,
  liveGitHubService,
} from "../../src/services/github-service";
import {
  HooksService,
  type HooksService as HooksServiceApi,
  liveHooksService,
} from "../../src/services/hooks-service";
import {
  IdeService,
  type IdeService as IdeServiceApi,
  liveIdeService,
} from "../../src/services/ide-service";
import {
  liveQueueStorage,
  QueueStorage,
  type QueueStorageService,
} from "../../src/services/queue-storage";
import {
  liveSetupService,
  SetupService,
  type SetupService as SetupServiceApi,
} from "../../src/services/setup-service";
import {
  liveTmuxService,
  TmuxService,
  type TmuxService as TmuxServiceApi,
} from "../../src/services/tmux";
import {
  liveVSCodeWorkspaceService,
  VSCodeWorkspaceService,
  type VSCodeWorkspaceService as VSCodeWorkspaceServiceApi,
} from "../../src/services/vscode-workspace";
import {
  liveWorktreeService,
  WorktreeService,
  type WorktreeService as WorktreeServiceApi,
} from "../../src/services/worktree-service";

export interface ServiceOverrides {
  github?: GitHubServiceApi;
  hooks?: HooksServiceApi;
  ide?: IdeServiceApi;
  json?: boolean;
  queueStorage?: QueueStorageService;
  setup?: SetupServiceApi;
  tmux?: TmuxServiceApi;
  vscodeWorkspace?: VSCodeWorkspaceServiceApi;
  worktree?: WorktreeServiceApi;
}

export function withTestServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  overrides: ServiceOverrides = {},
): Effect.Effect<A, E, Exclude<R, WctServices | typeof JsonFlag>> {
  let provided = effect;

  provided = Effect.provideService(
    provided,
    GitHubService,
    overrides.github ?? liveGitHubService,
  );
  provided = Effect.provideService(
    provided,
    HooksService,
    overrides.hooks ?? liveHooksService,
  );
  provided = Effect.provideService(
    provided,
    IdeService,
    overrides.ide ?? liveIdeService,
  );
  provided = Effect.provideService(
    provided,
    QueueStorage,
    overrides.queueStorage ?? liveQueueStorage,
  );
  provided = Effect.provideService(
    provided,
    SetupService,
    overrides.setup ?? liveSetupService,
  );
  provided = Effect.provideService(
    provided,
    TmuxService,
    overrides.tmux ?? liveTmuxService,
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
  provided = Effect.provideService(provided, JsonFlag, overrides.json ?? false);

  return provided as Effect.Effect<
    A,
    E,
    Exclude<R, WctServices | typeof JsonFlag>
  >;
}

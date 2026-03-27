import { BunServices } from "@effect/platform-bun";
import { Layer, ManagedRuntime } from "effect";
import type { WctServices } from "../effect/services";
import { GitHubService, liveGitHubService } from "../services/github-service";
import { HooksService, liveHooksService } from "../services/hooks-service";
import { IdeService, liveIdeService } from "../services/ide-service";
import { liveQueueStorage, QueueStorage } from "../services/queue-storage";
import {
  liveRegistryService,
  RegistryService,
} from "../services/registry-service";
import { liveSetupService, SetupService } from "../services/setup-service";
import { liveTmuxService, TmuxService } from "../services/tmux";
import {
  liveVSCodeWorkspaceService,
  VSCodeWorkspaceService,
} from "../services/vscode-workspace";
import {
  liveWorktreeService,
  WorktreeService,
} from "../services/worktree-service";

const tuiLayer = Layer.mergeAll(
  Layer.succeed(TmuxService, liveTmuxService),
  Layer.succeed(WorktreeService, liveWorktreeService),
  Layer.succeed(GitHubService, liveGitHubService),
  Layer.succeed(HooksService, liveHooksService),
  Layer.succeed(IdeService, liveIdeService),
  Layer.succeed(QueueStorage, liveQueueStorage),
  Layer.succeed(RegistryService, liveRegistryService),
  Layer.succeed(SetupService, liveSetupService),
  Layer.succeed(VSCodeWorkspaceService, liveVSCodeWorkspaceService),
  BunServices.layer,
);

export const tuiRuntime: ManagedRuntime.ManagedRuntime<WctServices, never> =
  ManagedRuntime.make(tuiLayer as Layer.Layer<WctServices>);

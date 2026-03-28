import { BunServices } from "@effect/platform-bun";
import { Layer, ManagedRuntime } from "effect";
import { GitHubService, liveGitHubService } from "../services/github-service";
import { liveQueueStorage, QueueStorage } from "../services/queue-storage";
import {
  liveRegistryService,
  RegistryService,
} from "../services/registry-service";
import { liveTmuxService, TmuxService } from "../services/tmux";
import {
  liveWorktreeService,
  WorktreeService,
} from "../services/worktree-service";

const tuiLayer = Layer.mergeAll(
  Layer.succeed(TmuxService, liveTmuxService),
  Layer.succeed(WorktreeService, liveWorktreeService),
  Layer.succeed(GitHubService, liveGitHubService),
  Layer.succeed(QueueStorage, liveQueueStorage),
  Layer.succeed(RegistryService, liveRegistryService),
  BunServices.layer,
);

export const tuiRuntime = ManagedRuntime.make(tuiLayer);

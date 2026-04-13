import { BunServices } from "@effect/platform-bun";
import { Layer, ManagedRuntime } from "effect";
import { GitHubService, liveGitHubService } from "../services/github-service";
import { IdeService, liveIdeService } from "../services/ide-service";
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
  Layer.succeed(IdeService, liveIdeService),
  Layer.succeed(RegistryService, liveRegistryService),
  BunServices.layer,
);

export const tuiRuntime = ManagedRuntime.make(tuiLayer);

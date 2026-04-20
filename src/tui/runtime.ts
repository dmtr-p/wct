import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, ManagedRuntime } from "effect";
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

const noop = () => {};

const silentConsole: Console.Console = {
  ...globalThis.console,
  assert: noop,
  clear: noop,
  count: noop,
  countReset: noop,
  debug: noop,
  dir: noop,
  dirxml: noop,
  error: noop,
  group: noop,
  groupCollapsed: noop,
  groupEnd: noop,
  info: noop,
  log: noop,
  table: noop,
  time: noop,
  timeEnd: noop,
  timeLog: noop,
  trace: noop,
  warn: noop,
};

export function runTuiSilentPromise<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Promise<A> {
  return tuiRuntime.runPromise(
    Effect.provideService(effect, Console.Console, silentConsole),
  );
}

import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { JsonFlag } from "../../src/cli/json-flag";
import {
  GitHubService,
  liveGitHubService,
} from "../../src/services/github-service";
import { IdeService, liveIdeService } from "../../src/services/ide-service";
import {
  liveRegistryService,
  RegistryService,
} from "../../src/services/registry-service";
import {
  liveSetupService,
  SetupService,
} from "../../src/services/setup-service";
import { liveTmuxService, TmuxService } from "../../src/services/tmux";
import {
  liveVSCodeWorkspaceService,
  VSCodeWorkspaceService,
} from "../../src/services/vscode-workspace";
import {
  liveWorktreeService,
  WorktreeService,
} from "../../src/services/worktree-service";
import type { ServiceOverrides } from "./services";

export type { ServiceOverrides };

/**
 * Layer providing every wct live service, JsonFlag=false, and BunServices.
 * BunServices is required because live services (worktree, tmux, github)
 * call execProcess / ChildProcess, which are provided by the Bun platform.
 * This mirrors the runtime composition of `runBunPromise(withTestServices(...))`.
 *
 * Use with `it.layer(WctTestLayer)((it) => { it.effect(...) })` from
 * @effect/vitest.
 */
export const WctTestLayer = Layer.mergeAll(
  Layer.succeed(GitHubService, liveGitHubService),
  Layer.succeed(IdeService, liveIdeService),
  Layer.succeed(SetupService, liveSetupService),
  Layer.succeed(TmuxService, liveTmuxService),
  Layer.succeed(VSCodeWorkspaceService, liveVSCodeWorkspaceService),
  Layer.succeed(WorktreeService, liveWorktreeService),
  Layer.succeed(RegistryService, liveRegistryService),
  Layer.succeed(JsonFlag, false),
  BunServices.layer,
);

/**
 * Variant of `WctTestLayer` that swaps in per-test overrides matching
 * the same shape as `withTestServices` from `./services.ts`. Use when a
 * single test or describe block needs a fake implementation. Also merges
 * in `BunServices.layer` so live fallthroughs that call execProcess work.
 */
export function wctTestLayer(overrides: ServiceOverrides = {}) {
  return Layer.mergeAll(
    Layer.succeed(GitHubService, overrides.github ?? liveGitHubService),
    Layer.succeed(IdeService, overrides.ide ?? liveIdeService),
    Layer.succeed(SetupService, overrides.setup ?? liveSetupService),
    Layer.succeed(TmuxService, overrides.tmux ?? liveTmuxService),
    Layer.succeed(
      VSCodeWorkspaceService,
      overrides.vscodeWorkspace ?? liveVSCodeWorkspaceService,
    ),
    Layer.succeed(WorktreeService, overrides.worktree ?? liveWorktreeService),
    Layer.succeed(RegistryService, overrides.registry ?? liveRegistryService),
    Layer.succeed(JsonFlag, overrides.json ?? false),
    BunServices.layer,
  );
}

// Compile-time exhaustiveness check: every key of `ServiceOverrides` must
// appear in the `_HandledOverrideKeys` union below. If a new optional key is
// added to `ServiceOverrides` in `./services.ts` and not handled by
// `wctTestLayer`, this assignment fails to compile, forcing the helper to be
// updated alongside. Keep the union literal in sync with the keys handled
// in `wctTestLayer` above.
type _HandledOverrideKeys =
  | "github"
  | "ide"
  | "json"
  | "registry"
  | "setup"
  | "tmux"
  | "vscodeWorkspace"
  | "worktree";
type _AssertOverridesExhaustive =
  keyof ServiceOverrides extends _HandledOverrideKeys
    ? _HandledOverrideKeys extends keyof ServiceOverrides
      ? true
      : never
    : never;
const _exhaustive: _AssertOverridesExhaustive = true;
void _exhaustive;

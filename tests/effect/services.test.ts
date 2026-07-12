import { BunServices } from "@effect/platform-bun";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { JsonFlag } from "../../src/cli/json-flag";
import { WctServicesLayer } from "../../src/effect/services";
import { GitHubService } from "../../src/services/github-service";
import { RegistryService } from "../../src/services/registry-service";
import { SetupService } from "../../src/services/setup-service";
import { TmuxService } from "../../src/services/tmux";
import { WorkspaceService } from "../../src/services/workspace-service";
import { WorktreeService } from "../../src/services/worktree-service";

describe("WctServicesLayer", () => {
  it.layer(Layer.mergeAll(WctServicesLayer, BunServices.layer))(
    "exposes every wct service plus JsonFlag",
    (it) => {
      it.effect(
        "resolves every service tag without missing-context errors",
        () =>
          Effect.gen(function* () {
            const github = yield* GitHubService;
            const registry = yield* RegistryService;
            const setup = yield* SetupService;
            const tmux = yield* TmuxService;
            const worktree = yield* WorktreeService;
            const workspace = yield* WorkspaceService;
            const json = yield* JsonFlag;

            expect(typeof github.isGhInstalled).toBe("function");
            expect(typeof registry.listRepos).toBe("function");
            expect(typeof setup.runSetupCommands).toBe("function");
            expect(typeof tmux.sessionExists).toBe("function");
            expect(typeof worktree.isGitRepo).toBe("function");
            expect(typeof workspace.up).toBe("function");
            expect(typeof workspace.down).toBe("function");
            expect(json).toBe(false);
          }),
      );
    },
  );
});

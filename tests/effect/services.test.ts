import { BunServices } from "@effect/platform-bun";
import { describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import { expect } from "vitest";
import { JsonFlag } from "../../src/cli/json-flag";
import { provideBunServices } from "../../src/effect/runtime";
import { WctServicesLayer } from "../../src/effect/services";
import { GitHubService } from "../../src/services/github-service";
import { RegistryService } from "../../src/services/registry-service";
import { SetupService } from "../../src/services/setup-service";
import { TmuxService } from "../../src/services/tmux";
import { WorkspaceService } from "../../src/services/workspace-service";
import {
  liveWorktreeService,
  makeWorktreeService,
  WorktreeService,
} from "../../src/services/worktree-service";

describe("WctServicesLayer", () => {
  it.effect(
    "binds platform dependencies while preserving caller settings",
    () =>
      Effect.gen(function* () {
        const fs = FileSystem.makeNoop({});
        let calls = 0;
        const worktree = yield* provideBunServices(
          makeWorktreeService({
            ...liveWorktreeService,
            getCurrentBranch: () =>
              Effect.gen(function* () {
                expect(yield* FileSystem.FileSystem).toBe(fs);
                const json = yield* Effect.serviceOption(JsonFlag);
                calls++;
                return Option.getOrElse(json, () => false) ? "json" : "human";
              }),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(JsonFlag, false),
          ),
        );

        expect(calls).toBe(0);
        expect(
          yield* worktree
            .getCurrentBranch()
            .pipe(Effect.provideService(JsonFlag, true)),
        ).toBe("json");
        expect(yield* worktree.getCurrentBranch()).toBe("human");
        expect(calls).toBe(2);
      }),
  );

  it.layer(WctServicesLayer.pipe(Layer.provideMerge(BunServices.layer)))(
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

            expect(Effect.isEffect(github.isGhInstalled)).toBe(true);
            expect(Effect.isEffect(registry.listRepos)).toBe(true);
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

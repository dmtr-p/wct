import { BunServices } from "@effect/platform-bun";
import { describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import { expect } from "vitest";
import { JsonFlag } from "../../src/cli/json-flag";
import { provideBunServices } from "../../src/effect/runtime";
import { WctServicesLayer } from "../../src/effect/services";
import {
  emptyAgentSnapshot,
  makeAgentService,
} from "../../src/services/agent-service";
import { GitHubService } from "../../src/services/github-service";
import { RegistryService } from "../../src/services/registry-service";
import {
  makeSetupService,
  SetupService,
} from "../../src/services/setup-service";
import { TmuxService } from "../../src/services/tmux";
import { WorkspaceService } from "../../src/services/workspace-service";
import {
  liveWorktreeService,
  makeWorktreeService,
  WorktreeService,
} from "../../src/services/worktree-service";

describe("WctServicesLayer", () => {
  it.effect(
    "setup captures platform services and preserves caller settings",
    () =>
      Effect.gen(function* () {
        const fs = FileSystem.makeNoop({});
        const setup = yield* provideBunServices(
          makeSetupService({
            runSetupCommands: () =>
              Effect.gen(function* () {
                expect(yield* FileSystem.FileSystem).toBe(fs);
                const json = yield* Effect.serviceOption(JsonFlag);
                return [
                  {
                    name: Option.getOrElse(json, () => false) ? "json" : "human",
                    _tag: "Succeeded" as const,
                  },
                ];
              }),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(JsonFlag, false),
          ),
        );
        const env = {
          WCT_WORKTREE_DIR: "/worktree",
          WCT_WORK_DIR: "/worktree",
          WCT_MAIN_DIR: "/repo",
          WCT_BRANCH: "feature",
          WCT_PROJECT: "project",
        };
        const command = setup.runSetupCommands([], "/worktree", env);
        const result = yield* command.pipe(
          Effect.provideService(JsonFlag, true),
          Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
        );
        expect(result).toEqual([{ name: "json", _tag: "Succeeded" }]);
        expect(yield* command).toEqual([{ name: "human", _tag: "Succeeded" }]);
      }),
  );

  it.effect(
    "agent observation captures platform services and preserves caller settings",
    () =>
      Effect.gen(function* () {
        const fs = FileSystem.makeNoop({});
        let observedJson = false;
        const agent = yield* provideBunServices(
          makeAgentService({
            discover: Effect.gen(function* () {
              expect(yield* FileSystem.FileSystem).toBe(fs);
              observedJson = Option.getOrElse(
                yield* Effect.serviceOption(JsonFlag),
                () => false,
              );
              return [];
            }),
            processes: Effect.succeed([]),
            arguments: () => Effect.succeed(new Map()),
            capture: () => Effect.succeed(""),
            now: () => 0,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(JsonFlag, false),
          ),
        );
        const observation = agent.observe(new Set(), emptyAgentSnapshot());
        const result = yield* observation.pipe(
          Effect.provideService(JsonFlag, true),
          Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
        );
        expect(result).toEqual(emptyAgentSnapshot());
        expect(observedJson).toBe(true);
        yield* observation;
        expect(observedJson).toBe(false);
      }),
  );

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

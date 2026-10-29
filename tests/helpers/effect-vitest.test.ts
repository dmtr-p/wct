import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { JsonFlag } from "../../src/cli/json-flag";
import { provideBunServices } from "../../src/effect/runtime";
import * as processService from "../../src/services/process";
import { TmuxService } from "../../src/services/tmux";
import { WorktreeService } from "../../src/services/worktree-service";
import { WctTestLayer, wctTestLayer } from "./effect-vitest";
import { noopTmuxService, withTestServices } from "./services";

describe("WctTestLayer", { concurrent: false }, () => {
  let nonGitDir: string;

  // Vitest registers this beforeAll before the it.layer block below registers
  // its own setup, so nonGitDir is initialized before any layered test body runs.
  beforeAll(() => {
    nonGitDir = mkdtempSync(join(tmpdir(), "wct-test-layer-non-git-"));
  });

  afterAll(() => {
    rmSync(nonGitDir, { recursive: true, force: true });
  });

  it.layer(WctTestLayer)("provides every wct service", (it) => {
    it.effect("WorktreeService.isGitRepo returns false in non-git dir", () =>
      Effect.gen(function* () {
        const wt = yield* WorktreeService;
        const result = yield* wt.isGitRepo(nonGitDir);
        expect(result).toBe(false);
      }),
    );

    it.effect("JsonFlag defaults to false", () =>
      Effect.gen(function* () {
        const json = yield* JsonFlag;
        expect(json).toBe(false);
      }),
    );
  });

  it.layer(
    wctTestLayer({
      json: true,
      tmux: {
        ...noopTmuxService,
        sessionExists: () => Effect.succeed(true),
        createSession: (sessionName) =>
          Effect.succeed({ _tag: "AlreadyExists", sessionName }),
      },
    }),
  )("wctTestLayer applies overrides", (it) => {
    it.effect("JsonFlag honors override", () =>
      Effect.gen(function* () {
        const json = yield* JsonFlag;
        expect(json).toBe(true);
      }),
    );

    it.effect("TmuxService honors explicit overrides", () =>
      Effect.gen(function* () {
        const tmux = yield* TmuxService;
        expect(yield* tmux.sessionExists("workspace")).toBe(true);
        expect(yield* tmux.createSession("workspace", "/tmp")).toEqual({
          _tag: "AlreadyExists",
          sessionName: "workspace",
        });
      }),
    );
  });
});

describe("test layer tmux defaults", { concurrent: false }, () => {
  // A regression must fail before it can create or kill a host tmux session.
  beforeEach(() => {
    vi.spyOn(processService, "execProcess").mockImplementation(() =>
      Effect.die("Unexpected host process execution"),
    );
    vi.spyOn(processService, "runProcess").mockImplementation(() =>
      Effect.die("Unexpected host process execution"),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const [name, layer] of [
    ["WctTestLayer", WctTestLayer],
    ["wctTestLayer()", wctTestLayer()],
    ["wctTestLayer({ tmux: undefined })", wctTestLayer({ tmux: undefined })],
  ] as const) {
    it.layer(layer)(name, (it) => {
      it.effect("uses no-op tmux operations by default", () =>
        Effect.gen(function* () {
          const tmux = yield* TmuxService;
          expect(yield* tmux.sessionExists("workspace")).toBe(false);
          expect(yield* tmux.createSession("workspace", "/tmp")).toEqual({
            _tag: "Created",
            sessionName: "workspace",
          });
          yield* tmux.killSession("workspace");
          yield* tmux.killPane("%1");
          expect(yield* tmux.listPanes("workspace")).toEqual([]);
          expect(processService.execProcess).not.toHaveBeenCalled();
          expect(processService.runProcess).not.toHaveBeenCalled();
        }),
      );
    });
  }

  it.effect.each([{}, { tmux: undefined }])(
    "withTestServices uses no-op tmux with options %j",
    (overrides) =>
      provideBunServices(
        withTestServices(
          Effect.gen(function* () {
            const tmux = yield* TmuxService;
            expect(yield* tmux.sessionExists("workspace")).toBe(false);
            expect(yield* tmux.createSession("workspace", "/tmp")).toEqual({
              _tag: "Created",
              sessionName: "workspace",
            });
            yield* tmux.killSession("workspace");
            expect(processService.execProcess).not.toHaveBeenCalled();
            expect(processService.runProcess).not.toHaveBeenCalled();
          }),
          overrides,
        ),
      ),
  );

  it.effect("withTestServices preserves an explicit tmux override", () =>
    provideBunServices(
      withTestServices(
        Effect.gen(function* () {
          const tmux = yield* TmuxService;
          expect(yield* tmux.sessionExists("workspace")).toBe(true);
          expect(processService.runProcess).not.toHaveBeenCalled();
        }),
        {
          tmux: {
            ...noopTmuxService,
            sessionExists: () => Effect.succeed(true),
          },
        },
      ),
    ),
  );
});

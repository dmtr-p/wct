import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, beforeAll, expect } from "vitest";
import { JsonFlag } from "../../src/cli/json-flag";
import { WorktreeService } from "../../src/services/worktree-service";
import { WctTestLayer, wctTestLayer } from "./effect-vitest";

describe("WctTestLayer", () => {
  let nonGitDir: string;

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
        // Calls into execProcess(`git rev-parse ...`); requires BunServices.
        // Asserting the negative case rules out both wiring and behavior.
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

  it.layer(wctTestLayer({ json: true }))(
    "wctTestLayer applies overrides",
    (it) => {
      it.effect("JsonFlag honors override", () =>
        Effect.gen(function* () {
          const json = yield* JsonFlag;
          expect(json).toBe(true);
        }),
      );
    },
  );
});

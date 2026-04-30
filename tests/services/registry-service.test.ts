import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach, expect } from "vitest";
import { RegistryService } from "../../src/services/registry-service";
import { WctTestLayer } from "../helpers/effect-vitest";

describe("registry-service", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `wct-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  // This is safe because liveRegistryService reads HOME lazily inside each
  // registry operation; if it starts opening the DB during layer construction,
  // this test must build the layer after beforeEach updates process.env.HOME.
  it.layer(WctTestLayer)("operates against $HOME registry", (it) => {
    it.effect("register and list repos", () =>
      Effect.gen(function* () {
        const registry = yield* RegistryService;

        const item = yield* registry.register("/tmp/fake-repo", "test-project");
        expect(item.repo_path).toBe("/tmp/fake-repo");
        expect(item.project).toBe("test-project");

        const repos = yield* registry.listRepos();
        expect(repos.length).toBeGreaterThanOrEqual(1);
        expect(
          repos.find((r) => r.repo_path === "/tmp/fake-repo"),
        ).toBeDefined();

        const removed = yield* registry.unregister("/tmp/fake-repo");
        expect(removed).toBe(true);
      }),
    );

    it.effect("register is idempotent and updates project name", () =>
      Effect.gen(function* () {
        const registry = yield* RegistryService;

        yield* registry.register("/tmp/idem-repo", "old-name");
        const updated = yield* registry.register("/tmp/idem-repo", "new-name");
        expect(updated.project).toBe("new-name");

        yield* registry.unregister("/tmp/idem-repo");
      }),
    );

    it.effect("unregister returns false for unknown path", () =>
      Effect.gen(function* () {
        const registry = yield* RegistryService;

        const removed = yield* registry.unregister("/tmp/does-not-exist");
        expect(removed).toBe(false);
      }),
    );
  });
});

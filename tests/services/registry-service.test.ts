import { Database } from "bun:sqlite";
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

    it.effect(
      "creates schema_version table with current version on first open",
      () =>
        Effect.gen(function* () {
          const registry = yield* RegistryService;
          yield* registry.listRepos();

          const db = new Database(`${process.env.HOME}/.wct/wct.db`, {
            readonly: true,
          });
          try {
            const row = db
              .query(
                "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
              )
              .get() as { version: number } | null;
            expect(row).not.toBeNull();
            expect(row?.version).toBe(1);
          } finally {
            db.close();
          }
        }),
    );

    it.effect(
      "register upsert updates project and returns single row",
      () =>
        Effect.gen(function* () {
          const registry = yield* RegistryService;

          yield* registry.register("/tmp/tx-repo", "alpha");
          yield* registry.register("/tmp/tx-repo", "beta");

          const repos = yield* registry.listRepos();
          const matches = repos.filter((r) => r.repo_path === "/tmp/tx-repo");
          expect(matches.length).toBe(1);
          expect(matches[0]?.project).toBe("beta");
        }),
    );

    it.effect("does not re-apply migrations on subsequent opens", () =>
      Effect.gen(function* () {
        const registry = yield* RegistryService;
        yield* registry.listRepos();
        yield* registry.listRepos();

        const db = new Database(`${process.env.HOME}/.wct/wct.db`, {
          readonly: true,
        });
        try {
          const rows = db
            .query("SELECT version FROM schema_version ORDER BY version ASC")
            .all() as { version: number }[];
          expect(rows.map((r) => r.version)).toEqual([1]);
        } finally {
          db.close();
        }
      }),
    );
  });
});

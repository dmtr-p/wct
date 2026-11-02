import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getCurrentSchemaVersion,
  TARGET_SCHEMA_VERSION,
  withDb,
  withDbEffect,
} from "../../src/services/db";

describe("database connection lifetimes", { concurrent: false }, () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wct-db-lifecycle-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  test("synchronous callbacks receive a migrated WAL database that closes on success", () => {
    let connection: Database | undefined;
    const result = Effect.runSync(
      withDb("registry_error", "read registry", (db) => {
        connection = db;
        return {
          version: getCurrentSchemaVersion(db),
          journal: db.query("PRAGMA journal_mode").get(),
        };
      }),
    );
    expect(result).toEqual({
      version: TARGET_SCHEMA_VERSION,
      journal: { journal_mode: "wal" },
    });
    expect(() => connection?.query("SELECT 1").get()).toThrow();
  });

  test("synchronous callback failures retain their cause and close the database", () => {
    const cause = new Error("callback failed");
    const close = vi.spyOn(Database.prototype, "close");
    const failure = Effect.runSync(
      Effect.flip(
        withDb("registry_error", "write registry", () => {
          throw cause;
        }),
      ),
    );
    expect(failure.code).toBe("registry_error");
    expect(failure.message).toBe(
      "Database operation failed during write registry",
    );
    expect(failure.cause).toBe(cause);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("Effect callbacks keep the database open until their work finishes", async () => {
    let connection: Database | undefined;
    const close = vi.spyOn(Database.prototype, "close");
    const result = await Effect.runPromise(
      withDbEffect("pr_cache_error", "read cache", (db) => {
        connection = db;
        return Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(close).not.toHaveBeenCalled();
              return getCurrentSchemaVersion(db);
            }),
          ),
        );
      }),
    );
    expect(result).toBe(TARGET_SCHEMA_VERSION);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => connection?.query("SELECT 1").get()).toThrow();
  });

  test("Effect callback failures retain their error and close the database", () => {
    const close = vi.spyOn(Database.prototype, "close");
    const failure = Effect.runSync(
      Effect.flip(
        withDbEffect("pr_cache_error", "write cache", () =>
          Effect.fail("callback failed"),
        ),
      ),
    );
    expect(failure).toBe("callback failed");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test.each(["defect", "throw"] as const)(
    "Effect callback %s retains operation context and closes the database",
    (kind) => {
      const cause = new Error("callback defect");
      const close = vi.spyOn(Database.prototype, "close");
      const failure = Effect.runSync(
        Effect.flip(
          withDbEffect("pr_cache_error", "write cache", () => {
            if (kind === "throw") throw cause;
            return Effect.die(cause);
          }),
        ),
      );
      expect(failure.code).toBe("pr_cache_error");
      expect(failure.message).toBe(
        "Database operation failed during write cache",
      );
      expect(failure.cause).toBe(cause);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  describe.each(["sync", "effect"] as const)("%s initialization", (kind) => {
    test.each(["WAL", "migration"] as const)(
      "%s failure closes the connection without replacing the original error",
      (stage) => {
        const cause = new Error(`${stage} failed`);
        const run = vi.spyOn(Database.prototype, "run");
        if (stage === "migration") {
          run.mockReturnValueOnce({ changes: 0, lastInsertRowid: 0 });
        }
        run.mockImplementationOnce(() => {
          throw cause;
        });
        // oxlint-disable-next-line typescript/unbound-method -- Called with the database instance below.
        const originalClose = Database.prototype.close;
        const close = vi
          .spyOn(Database.prototype, "close")
          .mockImplementationOnce(function (this: Database) {
            originalClose.call(this);
            throw new Error("close failed");
          });
        const callback = vi.fn((_db: Database) => "unused");
        const operation =
          kind === "sync"
            ? withDb("registry_error", "initialize", callback)
            : withDbEffect("registry_error", "initialize", (db) =>
                Effect.sync(() => callback(db)),
              );

        const failure = Effect.runSync(Effect.flip(operation));
        expect(failure.code).toBe("registry_error");
        expect(failure.message).toBe(
          "Database operation failed during initialize",
        );
        expect(failure.cause).toBe(cause);
        expect(callback).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
      },
    );
  });
});

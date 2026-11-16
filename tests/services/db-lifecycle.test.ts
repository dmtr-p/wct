import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
          busy: db.query("PRAGMA busy_timeout").get(),
        };
      }),
    );
    expect(result).toEqual({
      version: TARGET_SCHEMA_VERSION,
      journal: { journal_mode: "wal" },
      busy: { timeout: 1000 },
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
    test.each(["busy handler", "WAL", "migration"] as const)(
      "%s failure closes the connection without replacing the original error",
      (stage) => {
        const cause = new Error(`${stage} failed`);
        const run = vi.spyOn(Database.prototype, "run");
        if (stage !== "busy handler") {
          run.mockReturnValueOnce({ changes: 0, lastInsertRowid: 0 });
        }
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

    test.each(["released", "held"] as const)(
      "handles an initialization lock %s by another process without replaying the callback",
      async (state) => {
        Effect.runSync(withDb("registry_error", "initialize", () => undefined));
        const listening = Promise.withResolvers<void>();
        const child = Bun.spawn(
          [
            process.execPath,
            fileURLToPath(
              new URL("../fixtures/database-contention.ts", import.meta.url),
            ),
            join(home, ".wct/wct.db"),
          ],
          {
            stdout: "ignore",
            stderr: "pipe",
            ipc: (message: unknown) => {
              if (message === "locked") listening.resolve();
            },
          },
        );
        const errors = new Response(child.stderr).text();
        const readyTimer = setTimeout(
          () =>
            listening.reject(
              new Error("Database lock fixture readiness timed out"),
            ),
          2000,
        );
        try {
          await Promise.race([
            listening.promise,
            child.exited.then(() => {
              throw new Error("Database lock fixture exited before readiness");
            }),
          ]);
          clearTimeout(readyTimer);
          if (state === "released") child.send("release");
          const callback = vi.fn((db: Database) => getCurrentSchemaVersion(db));
          const operation =
            kind === "sync"
              ? withDb("registry_error", "read after contention", callback)
              : withDbEffect("registry_error", "read after contention", (db) =>
                  Effect.sync(() => callback(db)),
                );
          if (state === "released") {
            expect(Effect.runSync(operation)).toBe(TARGET_SCHEMA_VERSION);
            expect(callback).toHaveBeenCalledTimes(1);
            expect(await child.exited, await errors).toBe(0);
          } else {
            const failure = Effect.runSync(Effect.flip(operation));
            expect(failure.code).toBe("registry_error");
            expect(failure.cause).toMatchObject({ code: "SQLITE_BUSY" });
            expect(callback).not.toHaveBeenCalled();
          }
        } finally {
          clearTimeout(readyTimer);
          if (child.exitCode === null) child.kill();
          await child.exited;
        }
      },
    );
  });
});

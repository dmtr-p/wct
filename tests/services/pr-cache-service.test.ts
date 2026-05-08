import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/services/db";
import {
  sqlGetCached,
  sqlInvalidate,
  sqlSetCached,
  sqlSetError,
} from "../../src/services/pr-cache-service";
import type { PRInfo } from "../../src/tui/types";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode=WAL");
  runMigrations(db);
  return db;
}

const PR_A: PRInfo = {
  number: 1,
  title: "feat: add thing",
  state: "OPEN",
  headRefName: "feat/thing",
  rollupState: "success",
};

const PR_B: PRInfo = {
  number: 2,
  title: "fix: broken thing",
  state: "MERGED",
  headRefName: "fix/broken",
  rollupState: "failure",
};

describe("PrCacheService SQL helpers", () => {
  it("empty DB → getCached returns null", () => {
    const db = makeDb();
    expect(sqlGetCached(db, "my-project")).toBeNull();
    db.close();
  });

  it("round-trip: setCached then getCached returns the same payload", () => {
    const db = makeDb();
    sqlSetCached(db, "my-project", [PR_A, PR_B]);
    const entry = sqlGetCached(db, "my-project");
    expect(entry).not.toBeNull();
    expect(entry?.payload).toEqual([PR_A, PR_B]);
    expect(entry?.lastError).toBeNull();
    expect(entry?.fetchedAt).toBeGreaterThan(0);
    db.close();
  });

  it("empty array round-trips as [] and is distinct from null", () => {
    const db = makeDb();
    sqlSetCached(db, "empty-project", []);
    const entry = sqlGetCached(db, "empty-project");
    expect(entry).not.toBeNull();
    expect(entry?.payload).toEqual([]);
    db.close();
  });

  it("invalidate removes the row so getCached returns null", () => {
    const db = makeDb();
    sqlSetCached(db, "to-remove", [PR_A]);
    sqlInvalidate(db, "to-remove");
    expect(sqlGetCached(db, "to-remove")).toBeNull();
    db.close();
  });

  it("setError then getCached reflects last_error", () => {
    const db = makeDb();
    sqlSetError(db, "err-project", "network timeout");
    const entry = sqlGetCached(db, "err-project");
    expect(entry).not.toBeNull();
    expect(entry?.lastError).toBe("network timeout");
    // sentinel row has empty payload
    expect(entry?.payload).toEqual([]);
    db.close();
  });

  it("setError on existing row preserves previous payload", () => {
    const db = makeDb();
    sqlSetCached(db, "has-data", [PR_A]);
    sqlSetError(db, "has-data", "transient error");
    const entry = sqlGetCached(db, "has-data");
    expect(entry).not.toBeNull();
    expect(entry?.payload).toEqual([PR_A]);
    expect(entry?.lastError).toBe("transient error");
    db.close();
  });

  it("subsequent setCached after setError clears last_error", () => {
    const db = makeDb();
    sqlSetError(db, "recover-project", "initial error");
    sqlSetCached(db, "recover-project", [PR_B]);
    const entry = sqlGetCached(db, "recover-project");
    expect(entry).not.toBeNull();
    expect(entry?.payload).toEqual([PR_B]);
    expect(entry?.lastError).toBeNull();
    db.close();
  });

  it("two service instances writing to the same on-disk file produce well-formed rows", async () => {
    const dir = tmpdir();
    const dbPath = join(dir, `wct-test-concurrent-${Date.now()}.db`);
    let db1: Database | null = null;
    let db2: Database | null = null;

    try {
      db1 = new Database(dbPath, { create: true });
      db1.run("PRAGMA journal_mode=WAL");
      runMigrations(db1);

      db2 = new Database(dbPath, { readwrite: true, create: false });
      db2.run("PRAGMA journal_mode=WAL");
      runMigrations(db2);

      // Interleave writes from both connections
      sqlSetCached(db1, "proj-alpha", [PR_A]);
      sqlSetCached(db2, "proj-beta", [PR_B]);
      sqlSetCached(db1, "proj-alpha", [PR_A, PR_B]);
      sqlSetError(db2, "proj-beta", "some error");

      // Read back from the other connection to verify WAL visibility
      const alpha = sqlGetCached(db2, "proj-alpha");
      expect(alpha).not.toBeNull();
      expect(alpha?.payload).toEqual([PR_A, PR_B]);

      const beta = sqlGetCached(db1, "proj-beta");
      expect(beta).not.toBeNull();
      expect(beta?.payload).toEqual([PR_B]);
      expect(beta?.lastError).toBe("some error");
    } finally {
      try {
        db1?.close();
      } catch {
        /* ignore */
      }
      try {
        db2?.close();
      } catch {
        /* ignore */
      }
      try {
        rmSync(dbPath);
      } catch {
        /* ignore */
      }
      try {
        rmSync(`${dbPath}-wal`);
      } catch {
        /* ignore */
      }
      try {
        rmSync(`${dbPath}-shm`);
      } catch {
        /* ignore */
      }
    }
  });
});

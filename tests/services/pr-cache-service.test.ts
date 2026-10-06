import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/services/db";
import {
  sqlGetOpenPrs,
  sqlInvalidate,
  sqlSetOpenPrs,
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
  state: "OPEN",
  headRefName: "fix/broken",
  rollupState: "failure",
};

describe("PrCacheService SQL helpers", () => {
  it("invalidate removes the repository's Open-modal cache", () => {
    const db = makeDb();
    sqlSetOpenPrs(db, "/to-remove", [PR_A]);
    sqlInvalidate(db, "/to-remove");
    expect(sqlGetOpenPrs(db, "/to-remove")).toBeNull();
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
      sqlSetOpenPrs(db1, "/repos/alpha", [PR_A]);
      sqlSetOpenPrs(db2, "/repos/beta", [PR_B]);
      sqlSetOpenPrs(db1, "/repos/alpha", [PR_A, PR_B]);

      // Read back from the other connection to verify WAL visibility
      const alpha = sqlGetOpenPrs(db2, "/repos/alpha");
      expect(alpha).not.toBeNull();
      expect(alpha?.payload).toEqual([PR_A, PR_B]);

      const beta = sqlGetOpenPrs(db1, "/repos/beta");
      expect(beta).not.toBeNull();
      expect(beta?.payload).toEqual([PR_B]);
      expect(beta?.lastError).toBeNull();
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

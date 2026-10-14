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
  sqlGetDiscovery,
  sqlSetDiscovery,
} from "../../src/services/pr-cache-service";
import { normalizeGhPr } from "../../src/services/pr-discovery";
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
  it("persists complete discovery across connections and invalidates it by repository", () => {
    const path = join(tmpdir(), `wct-discovery-${Date.now()}.db`);
    let first: Database | null = null;
    let second: Database | null = null;
    try {
      first = new Database(path);
      runMigrations(first);
      const pr = normalizeGhPr(
        { number: 1, title: "old", state: "MERGED", headRefName: "feature" },
        "base/repo",
        1,
      );
      if (!pr) throw new Error("Invalid fixture");
      const snapshot = {
        baseRepository: "base/repo",
        prs: [pr],
        explicitPrs: [],
        openNumbers: [],
        fetchedAt: 1,
      };
      sqlSetDiscovery(first, "/a", snapshot);
      sqlSetDiscovery(first, "/b", snapshot);
      first.close();
      first = null;
      second = new Database(path);
      expect(sqlGetDiscovery(second, "/a")).toEqual(snapshot);
      sqlInvalidate(second, "/a");
      expect(sqlGetDiscovery(second, "/a")).toBeNull();
      expect(sqlGetDiscovery(second, "/b")).toEqual(snapshot);
    } finally {
      first?.close();
      second?.close();
      rmSync(path, { force: true });
    }
  });

  it("rejects corrupt discovery rather than treating partial history as complete", () => {
    const db = makeDb();
    try {
      for (const payload of [
        "null",
        "{}",
        JSON.stringify({
          baseRepository: "base/repo",
          prs: [null],
          explicitPrs: [],
          openNumbers: [],
          fetchedAt: 1,
        }),
      ]) {
        db.run("INSERT OR REPLACE INTO pr_discovery_cache VALUES (?, ?)", [
          "/a",
          payload,
        ]);
        expect(sqlGetDiscovery(db, "/a")).toBeNull();
      }
    } finally {
      db.close();
    }
  });

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

      sqlSetOpenPrs(db1, "/repos/alpha", [PR_A]);
      sqlSetOpenPrs(db2, "/repos/beta", [PR_B]);
      sqlSetOpenPrs(db1, "/repos/alpha", [PR_A, PR_B]);

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

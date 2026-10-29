import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/services/db";
import {
  sqlGetDiscovery,
  sqlGetDiscoveryEffect,
  sqlGetOpenPrs,
  sqlInvalidate,
  sqlOwnedWrite,
  sqlSetDiscovery,
  sqlSetOpenPrs,
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
  it("yields while hydrating history without mixing concurrent cache revisions", async () => {
    const path = join(tmpdir(), `wct-discovery-yield-${Date.now()}.db`);
    const first = new Database(path);
    const second = new Database(path);
    try {
      first.run("PRAGMA journal_mode=WAL");
      runMigrations(first);
      const prs = Array.from({ length: 300 }, (_, index) =>
        normalizeGhPr(
          {
            number: index + 1,
            title: "original",
            headRefName: "feature",
            state: "MERGED",
          },
          "base/repo",
          1,
        ),
      ).filter((pr) => pr !== null);
      const snapshot = {
        baseRepository: "base/repo",
        prs,
        explicitPrs: [],
        openNumbers: [],
        fetchedAt: 1,
        discoveredThrough: 1,
      };
      sqlSetDiscovery(first, "/a", snapshot);
      let yielded = false;
      const pending = Effect.runPromise(sqlGetDiscoveryEffect(first, "/a"));
      const otherWrite = new Promise<void>((resolve) =>
        setTimeout(() => {
          yielded = true;
          sqlSetDiscovery(second, "/a", {
            ...snapshot,
            prs: prs.map((pr) => ({ ...pr, title: "new revision" })),
          });
          resolve();
        }, 0),
      );
      const loaded = await pending;
      const yieldedWhileLoading = yielded;
      await otherWrite;
      expect(yieldedWhileLoading).toBe(true);
      expect(loaded?.prs).toHaveLength(300);
      expect(loaded?.prs.every((pr) => pr.title === "original")).toBe(true);
      expect(
        sqlGetDiscovery(first, "/a")?.prs.every(
          (pr) => pr.title === "new revision",
        ),
      ).toBe(true);
    } finally {
      first.close();
      second.close();
      rmSync(path, { force: true });
    }
  });

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
        discoveredThrough: 1,
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

  it("writes only changed PR facts and skips unchanged snapshots", () => {
    const db = makeDb();
    try {
      const pr = normalizeGhPr(
        { number: 1, title: "old", state: "MERGED", headRefName: "feature" },
        "base/repo",
        1,
      );
      if (!pr) throw new Error("Invalid fixture");
      const first = {
        baseRepository: "base/repo",
        prs: [pr],
        explicitPrs: [],
        openNumbers: [],
        fetchedAt: 1,
        discoveredThrough: 1,
      };
      sqlSetDiscovery(db, "/a", first);
      const changes = () =>
        (db.query("SELECT total_changes() AS count").get() as { count: number })
          .count;
      const before = changes();
      sqlSetDiscovery(db, "/a", first, first);
      expect(changes()).toBe(before);
      const checkpoint = { ...first, fetchedAt: 2 };
      sqlSetDiscovery(db, "/a", checkpoint, first);
      expect(changes() - before).toBe(1);
      const next = { ...checkpoint, prs: [{ ...pr, title: "changed" }] };
      sqlSetDiscovery(db, "/a", next, checkpoint);
      expect(changes() - before).toBe(3);
      expect(sqlGetDiscovery(db, "/a")?.prs[0]?.title).toBe("changed");
    } finally {
      db.close();
    }
  });

  it("rebuilds facts when another connection replaced the previous snapshot", () => {
    const path = join(tmpdir(), `wct-discovery-revision-${Date.now()}.db`);
    const first = new Database(path);
    const second = new Database(path);
    try {
      runMigrations(first);
      const pr = normalizeGhPr(
        { number: 1, title: "old", state: "MERGED", headRefName: "feature" },
        "base/repo",
        1,
      );
      if (!pr) throw new Error("Invalid fixture");
      const original = {
        baseRepository: "base/repo",
        prs: [pr],
        explicitPrs: [],
        openNumbers: [],
        fetchedAt: 1,
        discoveredThrough: 1,
      };
      sqlSetDiscovery(first, "/a", original);
      const previous = sqlGetDiscovery(first, "/a");
      if (!previous) throw new Error("Missing fixture snapshot");
      sqlSetDiscovery(second, "/a", {
        ...original,
        baseRepository: "new/repo",
        prs: [{ ...pr, baseRepository: "new/repo", number: 2 }],
      });
      const next = { ...previous, fetchedAt: 2 };
      sqlSetDiscovery(first, "/a", next, previous);
      expect(sqlGetDiscovery(second, "/a")).toEqual(next);
      // Equal timestamps still need a new revision when another writer changes facts.
      const loaded = sqlGetDiscovery(first, "/a");
      if (!loaded) throw new Error("Missing fixture snapshot");
      sqlSetDiscovery(second, "/a", {
        ...next,
        prs: [{ ...pr, title: "changed" }],
      });
      sqlSetDiscovery(first, "/a", loaded, loaded);
      expect(sqlGetDiscovery(second, "/a")).toEqual(loaded);
    } finally {
      first.close();
      second.close();
      rmSync(path, { force: true });
    }
  });

  it("fences stale refresh writes after project removal and re-registration", () => {
    const db = makeDb();
    try {
      const snapshot = {
        baseRepository: "base/repo",
        prs: [],
        explicitPrs: [],
        openNumbers: [],
        fetchedAt: 1,
        discoveredThrough: 1,
      };
      db.run("INSERT INTO registry VALUES (?, ?, ?, ?)", [
        "original",
        "/a",
        "repo",
        1,
      ]);
      expect(sqlSetDiscovery(db, "/a", snapshot, null, "original")).toBe(true);
      db.run("DELETE FROM registry WHERE repo_path = ?", ["/a"]);
      sqlInvalidate(db, "/a");
      expect(sqlSetDiscovery(db, "/a", snapshot, null, "original")).toBe(false);
      expect(
        sqlOwnedWrite(db, "/a", "original", () =>
          sqlSetOpenPrs(db, "/a", [PR_A]),
        ),
      ).toBe(false);
      expect(sqlGetOpenPrs(db, "/a")).toBeNull();
      db.run("INSERT INTO registry VALUES (?, ?, ?, ?)", [
        "new",
        "/a",
        "repo",
        2,
      ]);
      expect(sqlSetDiscovery(db, "/a", snapshot, null, "original")).toBe(false);
      expect(sqlSetDiscovery(db, "/a", snapshot, null, "new")).toBe(true);
    } finally {
      db.close();
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

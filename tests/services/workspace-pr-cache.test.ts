import { Database } from "bun:sqlite";
import { describe, expect, test } from "vitest";
import { runMigrations } from "../../src/services/db";
import {
  sqlClearExplicit,
  sqlGetExplicit,
  sqlGetOpenPrs,
  sqlGetWorkspace,
  sqlInvalidate,
  sqlPruneWorkspaces,
  sqlSetExplicit,
  sqlSetOpenPrs,
  sqlSetWorkspace,
  sqlSetWorkspaceError,
} from "../../src/services/pr-cache-service";
import { normalizeGhPr } from "../../src/services/pr-discovery";

function db() {
  const database = new Database(":memory:");
  runMigrations(database);
  return database;
}

describe("Workspace PR cache", () => {
  test("reads legacy association metadata and omits it when rewriting the cache", () => {
    const database = db();
    try {
      const pr = normalizeGhPr(
        {
          number: 1,
          title: "selected",
          state: "MERGED",
          headRefName: "feature",
        },
        "base/repo",
        123,
      );
      const candidate = normalizeGhPr(
        { number: 2, title: "newer", state: "OPEN", headRefName: "feature" },
        "base/repo",
        123,
      );
      const payload = {
        pr,
        candidates: [candidate],
        newerOpenPr: 2,
        explicit: true,
      };
      database.run(
        "INSERT INTO workspace_pr_cache (repo_path, branch, payload, fetched_at, last_error) VALUES (?, ?, ?, ?, ?)",
        [
          "/a",
          "feature",
          JSON.stringify({ ...payload, uncertain: false }),
          123,
          "offline",
        ],
      );

      const entry = sqlGetWorkspace(database, "/a", "feature");
      expect(entry).toEqual({
        ...payload,
        fetchedAt: 123,
        lastError: "offline",
      });
      if (!entry) throw new Error("Expected legacy cache entry");
      sqlSetWorkspace(database, "/a", "feature", entry);
      const row = database
        .query(
          "SELECT payload FROM workspace_pr_cache WHERE repo_path = ? AND branch = ?",
        )
        .get("/a", "feature") as { payload: string };
      expect(JSON.parse(row.payload)).toEqual(payload);
      expect(sqlGetWorkspace(database, "/a", "feature")).toEqual(entry);
    } finally {
      database.close();
    }
  });

  test("keys by main repo path and branch, retaining complete data on error", () => {
    const database = db();
    const entry = {
      pr: null,
      candidates: [],
      newerOpenPr: null,
      fetchedAt: 123,
      lastError: null,
    };
    sqlSetWorkspace(database, "/a", "feature", entry);
    sqlSetWorkspace(database, "/b", "feature", { ...entry, fetchedAt: 456 });
    sqlSetWorkspaceError(database, "/a", "feature", "offline");
    expect(sqlGetWorkspace(database, "/a", "feature")).toEqual({
      ...entry,
      lastError: "offline",
      explicit: false,
    });
    expect(sqlGetWorkspace(database, "/b", "feature")?.fetchedAt).toBe(456);
    database.close();
  });

  test("Explicit PR Association replaces and clears independently of cache", () => {
    const database = db();
    sqlSetExplicit(database, "/a", "feature", {
      baseRepository: "base/repo",
      number: 1,
    });
    sqlSetExplicit(database, "/a", "feature", {
      baseRepository: "base/repo",
      number: 2,
    });
    expect(sqlGetExplicit(database, "/a", "feature")?.number).toBe(2);
    sqlClearExplicit(database, "/a", "feature");
    expect(sqlGetExplicit(database, "/a", "feature")).toBeNull();
    database.close();
  });

  test("pruning only removes absent Workspace identities when explicitly invoked", () => {
    const database = db();
    const entry = {
      pr: null,
      candidates: [],
      newerOpenPr: null,
      fetchedAt: 123,
      lastError: null,
    };
    sqlSetWorkspace(database, "/a", "kept", entry);
    sqlSetWorkspace(database, "/a", "gone", entry);
    sqlSetExplicit(database, "/a", "gone", {
      baseRepository: "base/repo",
      number: 2,
    });
    sqlPruneWorkspaces(database, "/a", ["kept"]);
    expect(sqlGetWorkspace(database, "/a", "kept")).not.toBeNull();
    expect(sqlGetWorkspace(database, "/a", "gone")).toBeNull();
    expect(sqlGetExplicit(database, "/a", "gone")).toBeNull();
    database.close();
  });

  test("pruning rolls back cache deletes if association deletion fails", () => {
    const database = db();
    sqlSetWorkspace(database, "/a", "gone", {
      pr: null,
      candidates: [],
      newerOpenPr: null,
      fetchedAt: 123,
      lastError: null,
    });
    sqlSetExplicit(database, "/a", "gone", {
      baseRepository: "base/repo",
      number: 2,
    });
    database.run(`CREATE TRIGGER block_association_delete
      BEFORE DELETE ON workspace_pr_association
      BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    expect(() => sqlPruneWorkspaces(database, "/a", [])).toThrow("blocked");
    expect(sqlGetWorkspace(database, "/a", "gone")).not.toBeNull();
    expect(sqlGetExplicit(database, "/a", "gone")).not.toBeNull();
    database.close();
  });

  test("invalidation clears only repository-owned caches and preserves associations", () => {
    const database = db();
    const entry = {
      pr: null,
      candidates: [],
      newerOpenPr: null,
      fetchedAt: 123,
      lastError: null,
    };
    const prs = [
      {
        number: 1,
        title: "open",
        state: "OPEN" as const,
        headRefName: "feature",
      },
    ];
    try {
      for (const path of ["/a", "/b"]) {
        database.run(
          "INSERT INTO registry (id, repo_path, project, created_at) VALUES (?, ?, ?, ?)",
          [path, path, "same-name", 1],
        );
        sqlSetWorkspace(database, path, "feature", entry);
        sqlSetOpenPrs(database, path, prs);
        sqlSetExplicit(database, path, "feature", {
          baseRepository: "base/repo",
          number: 1,
        });
      }
      sqlSetWorkspace(database, "/a", "another", entry);

      sqlInvalidate(database, "/a");
      sqlInvalidate(database, "/a");

      expect(sqlGetWorkspace(database, "/a", "feature")).toBeNull();
      expect(sqlGetWorkspace(database, "/a", "another")).toBeNull();
      expect(sqlGetOpenPrs(database, "/a")).toBeNull();
      expect(sqlGetWorkspace(database, "/b", "feature")?.fetchedAt).toBe(123);
      expect(sqlGetOpenPrs(database, "/b")?.payload).toEqual(prs);
      expect(sqlGetExplicit(database, "/a", "feature")?.number).toBe(1);
      expect(sqlGetExplicit(database, "/b", "feature")?.number).toBe(1);
    } finally {
      database.close();
    }
  });

  test("invalidation rolls back both repository caches if a delete fails", () => {
    const database = db();
    try {
      sqlSetWorkspace(database, "/a", "feature", {
        pr: null,
        candidates: [],
        newerOpenPr: null,
        fetchedAt: 123,
        lastError: null,
      });
      sqlSetOpenPrs(database, "/a", []);
      database.run(`CREATE TRIGGER block_open_cache_delete
        BEFORE DELETE ON open_pr_cache
        BEGIN SELECT RAISE(ABORT, 'blocked'); END`);

      expect(() => sqlInvalidate(database, "/a")).toThrow("blocked");
      expect(sqlGetWorkspace(database, "/a", "feature")).not.toBeNull();
      expect(sqlGetOpenPrs(database, "/a")).not.toBeNull();
    } finally {
      database.close();
    }
  });

  test("Open modal cache filters terminal PRs on write and hydration", () => {
    const database = db();
    sqlSetOpenPrs(database, "/a", [
      {
        number: 1,
        title: "open",
        state: "OPEN",
        headRefName: "a",
      },
      {
        number: 2,
        title: "merged",
        state: "MERGED",
        headRefName: "b",
      },
    ]);
    expect(
      sqlGetOpenPrs(database, "/a")?.payload.map((pr) => pr.number),
    ).toEqual([1]);
    database.close();
  });
});

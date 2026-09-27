import { Database } from "bun:sqlite";
import { describe, expect, test } from "vitest";
import { runMigrations } from "../../src/services/db";
import {
  sqlClearExplicit, sqlGetExplicit, sqlGetOpenPrs, sqlGetWorkspace,
  sqlPruneWorkspaces, sqlSetExplicit, sqlSetOpenPrs, sqlSetWorkspace, sqlSetWorkspaceError,
} from "../../src/services/pr-cache-service";

function db() {
  const database = new Database(":memory:");
  runMigrations(database);
  return database;
}

describe("Workspace PR cache", () => {
  test("keys by main repo path and branch, retaining complete data on error", () => {
    const database = db();
    const entry = { pr: null, candidates: [], newerOpenPr: null, uncertain: true, fetchedAt: 123, lastError: null };
    sqlSetWorkspace(database, "/a", "feature", entry);
    sqlSetWorkspace(database, "/b", "feature", { ...entry, fetchedAt: 456 });
    sqlSetWorkspaceError(database, "/a", "feature", "offline");
    expect(sqlGetWorkspace(database, "/a", "feature")).toEqual({ ...entry, lastError: "offline", explicit: false });
    expect(sqlGetWorkspace(database, "/b", "feature")?.fetchedAt).toBe(456);
    database.close();
  });

  test("explicit association replaces and clears independently of cache", () => {
    const database = db();
    sqlSetExplicit(database, "/a", "feature", { baseRepository: "base/repo", number: 1 });
    sqlSetExplicit(database, "/a", "feature", { baseRepository: "base/repo", number: 2 });
    expect(sqlGetExplicit(database, "/a", "feature")?.number).toBe(2);
    sqlClearExplicit(database, "/a", "feature");
    expect(sqlGetExplicit(database, "/a", "feature")).toBeNull();
    database.close();
  });

  test("pruning only removes absent Workspace identities when explicitly invoked", () => {
    const database = db();
    const entry = { pr: null, candidates: [], newerOpenPr: null, uncertain: true, fetchedAt: 123, lastError: null };
    sqlSetWorkspace(database, "/a", "kept", entry);
    sqlSetWorkspace(database, "/a", "gone", entry);
    sqlSetExplicit(database, "/a", "gone", { baseRepository: "base/repo", number: 2 });
    sqlPruneWorkspaces(database, "/a", ["kept"]);
    expect(sqlGetWorkspace(database, "/a", "kept")).not.toBeNull();
    expect(sqlGetWorkspace(database, "/a", "gone")).toBeNull();
    expect(sqlGetExplicit(database, "/a", "gone")).toBeNull();
    database.close();
  });

  test("Open modal cache filters terminal PRs on write and hydration", () => {
    const database = db();
    sqlSetOpenPrs(database, "/a", [
      { number: 1, title: "open", state: "OPEN", headRefName: "a", rollupState: null },
      { number: 2, title: "merged", state: "MERGED", headRefName: "b", rollupState: null },
    ]);
    expect(sqlGetOpenPrs(database, "/a")?.payload.map((pr) => pr.number)).toEqual([1]);
    database.close();
  });
});

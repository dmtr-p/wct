import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import {
  getCurrentSchemaVersion,
  MIGRATIONS,
  runMigrations,
  TARGET_SCHEMA_VERSION,
} from "../../src/services/db";

describe("wct-db migration runner", () => {
  it("fresh DB: applies all migrations and records schema_version rows", () => {
    const db = new Database(":memory:");

    runMigrations(db);

    // schema_version table exists and has exactly one row per version
    const rows = db
      .query("SELECT version FROM schema_version ORDER BY version ASC")
      .all() as { version: number }[];

    expect(rows.length).toBe(TARGET_SCHEMA_VERSION);
    expect(rows.map((r) => r.version)).toEqual(
      Array.from({ length: TARGET_SCHEMA_VERSION }, (_, i) => i + 1),
    );
    expect(getCurrentSchemaVersion(db)).toBe(MIGRATIONS.length);

    db.close();
  });

  it("legacy v1 DB: existing rows survive and schema_version reflects v1 applied", () => {
    const db = new Database(":memory:");

    // Simulate legacy DB: registry table with data, no schema_version
    db.run(`CREATE TABLE registry (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.run(
      "INSERT INTO registry (id, repo_path, project, created_at) VALUES (?, ?, ?, ?)",
      ["legacy-1", "/tmp/legacy-repo", "old-project", 1000],
    );

    runMigrations(db);

    // Existing data must survive
    const legacyRow = db
      .query("SELECT * FROM registry WHERE repo_path = ?")
      .get("/tmp/legacy-repo") as { project: string } | null;
    expect(legacyRow).not.toBeNull();
    expect(legacyRow?.project).toBe("old-project");

    // schema_version now reflects v1 applied (and any future versions)
    const version = getCurrentSchemaVersion(db);
    expect(version).toBe(TARGET_SCHEMA_VERSION);

    db.close();
  });

  it("running migrations twice is a no-op: no duplicate schema_version rows", () => {
    const db = new Database(":memory:");

    runMigrations(db);
    runMigrations(db);

    const rows = db
      .query("SELECT version FROM schema_version ORDER BY version ASC")
      .all() as { version: number }[];

    // Each version appears exactly once
    expect(rows.length).toBe(TARGET_SCHEMA_VERSION);
    expect(rows.map((r) => r.version)).toEqual(
      Array.from({ length: TARGET_SCHEMA_VERSION }, (_, i) => i + 1),
    );

    db.close();
  });

  it("v1 migration statement is idempotent: applying manually then running migrations produces clean state", () => {
    const db = new Database(":memory:");

    // Apply the v1 SQL directly (simulating partial state)
    const v1Sql = MIGRATIONS[0];
    expect(v1Sql).toBeDefined();
    if (v1Sql === undefined) {
      throw new Error("Missing v1 migration");
    }
    db.run(v1Sql);

    // runMigrations should handle this cleanly because v1 uses CREATE TABLE IF NOT EXISTS
    expect(() => runMigrations(db)).not.toThrow();

    // schema_version exists and records the correct version
    const version = getCurrentSchemaVersion(db);
    expect(version).toBe(TARGET_SCHEMA_VERSION);

    // registry table is in good shape (no duplicate tables or errors)
    const tableCheck = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='registry'",
      )
      .get() as { name: string } | null;
    expect(tableCheck).not.toBeNull();

    db.close();
  });
});

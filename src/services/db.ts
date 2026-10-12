import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { Effect } from "effect";
import { commandError, type ErrorCode, type WctError } from "../errors";

export function getWctDir(): string {
  return `${process.env.HOME ?? "/tmp"}/.wct`;
}

export function getDbPath(): string {
  return `${getWctDir()}/wct.db`;
}

const SCHEMA_VERSION_SQL = `CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`;

/**
 * Append only: index N advances schema version N to N+1. Editing, reordering,
 * or deleting entries breaks databases that have already applied them.
 * Statements must tolerate preexisting tables in databases without schema_version.
 * The runner records each successful version within one upgrade transaction.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS registry (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL UNIQUE,
    project TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pr_cache (
    project TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    last_error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_pr_cache (
    repo_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    last_error TEXT,
    PRIMARY KEY (repo_path, branch)
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_pr_association (
    repo_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_repository TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    PRIMARY KEY (repo_path, branch)
  )`,
  `CREATE TABLE IF NOT EXISTS open_pr_cache (
    repo_path TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    last_error TEXT
  )`,
  `DROP TABLE IF EXISTS pr_cache`,
];

export const TARGET_SCHEMA_VERSION = MIGRATIONS.length;

/** Exported for test access; use `runMigrations` in production code. */
export function getCurrentSchemaVersion(db: Database): number {
  const row = db
    .query("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | null;
  return row?.version ?? 0;
}

export function runMigrations(db: Database): void {
  db.run(SCHEMA_VERSION_SQL);

  const current = getCurrentSchemaVersion(db);
  if (current >= TARGET_SCHEMA_VERSION) return;

  const apply = db.transaction(() => {
    // Re-check inside the write lock — another process may have migrated
    // between the fast-path read and acquiring this lock.
    const version = getCurrentSchemaVersion(db);
    if (version >= TARGET_SCHEMA_VERSION) return;

    for (let v = version; v < TARGET_SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v];
      if (!sql) continue;
      db.run(sql);
      db.run("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", [
        v + 1,
        Date.now(),
      ]);
    }
  });
  apply.immediate();
}

/** Consumers choose the command error code for database failures. */
export function withDb<A>(
  errorCode: ErrorCode,
  operation: string,
  f: (db: Database) => A,
): Effect.Effect<A, WctError> {
  return Effect.try({
    try: () => {
      mkdirSync(getWctDir(), { recursive: true });
      const db = new Database(getDbPath(), { create: true });
      try {
        db.run("PRAGMA journal_mode=WAL");
        runMigrations(db);
        return f(db);
      } finally {
        db.close();
      }
    },
    catch: (error) =>
      commandError(
        errorCode,
        `Database operation failed during ${operation}`,
        error,
      ),
  });
}

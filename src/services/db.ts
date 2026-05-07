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
 * Append-only migrations table. Index N (0-based) is the SQL applied to
 * advance from version N to version N+1.
 *
 * Rules:
 *  - Never edit, reorder, or delete an entry — that breaks DBs already at
 *    that version.
 *  - Always append. To add v2, push exactly one new SQL string.
 *  - Each statement must be idempotent against a partially-applied schema
 *    (use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` only
 *    after a presence check via PRAGMA, etc.) so legacy DBs that pre-date
 *    schema_version converge cleanly on first open.
 *  - The migration runner records `(version, applied_at)` in
 *    `schema_version` after each statement succeeds; the whole upgrade
 *    runs inside a single sqlite transaction, so a mid-upgrade crash
 *    rolls back to the previous version.
 *
 * `TARGET_SCHEMA_VERSION` is derived from this array's length — do not
 * hand-edit it.
 */
export const MIGRATIONS: readonly string[] = [
  // v1 — initial registry schema. Matches the legacy CREATE TABLE IF NOT
  // EXISTS shape so DBs that pre-date schema_version (and therefore are
  // recorded as v0) re-converge cleanly without a destructive migration.
  `CREATE TABLE IF NOT EXISTS registry (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL UNIQUE,
    project TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
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

  // Fast path: skip the write lock when already at target version.
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

/**
 * Open the wct database, run migrations, execute `f`, then close the DB.
 * The `errorCode` parameter lets each consumer attach its own error tag
 * (e.g. `"registry_error"`) while sharing the migration/path logic.
 */
export function withDb<A>(
  errorCode: ErrorCode,
  operation: string,
  f: (db: Database) => A,
): Effect.Effect<A, WctError> {
  return Effect.try({
    try: () => {
      mkdirSync(getWctDir(), { recursive: true });
      const db = new Database(getDbPath(), { create: true });
      db.run("PRAGMA journal_mode=WAL");
      runMigrations(db);
      try {
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

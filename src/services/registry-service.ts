import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { Context, Effect } from "effect";
import { commandError, type WctError } from "../errors";

function getWctDir(): string {
  return `${process.env.HOME ?? "/tmp"}/.wct`;
}

function getDbPath(): string {
  return `${getWctDir()}/wct.db`;
}

export interface RegistryItem {
  id: string;
  repo_path: string;
  project: string;
  created_at: number;
}

export interface RegistryServiceApi {
  register: (
    repoPath: string,
    project: string,
  ) => Effect.Effect<RegistryItem, WctError>;
  unregister: (repoPath: string) => Effect.Effect<boolean, WctError>;
  listRepos: () => Effect.Effect<RegistryItem[], WctError>;
  findByPath: (
    repoPath: string,
  ) => Effect.Effect<RegistryItem | null, WctError>;
}

export const RegistryService = Context.Service<RegistryServiceApi>(
  "wct/RegistryService",
);

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
const MIGRATIONS: readonly string[] = [
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

const TARGET_SCHEMA_VERSION = MIGRATIONS.length;

function getCurrentSchemaVersion(db: Database): number {
  const row = db
    .query("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | null;
  return row?.version ?? 0;
}

function runMigrations(db: Database): void {
  db.run(SCHEMA_VERSION_SQL);
  const current = getCurrentSchemaVersion(db);
  if (current >= TARGET_SCHEMA_VERSION) return;

  const apply = db.transaction(() => {
    for (let v = current; v < TARGET_SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v];
      if (!sql) continue;
      db.run(sql);
      db.run(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
        [v + 1, Date.now()],
      );
    }
  });
  apply();
}

function generateId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function withDb<A>(
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
        "registry_error",
        `Registry database operation failed during ${operation}`,
        error,
      ),
  });
}

export const liveRegistryService: RegistryServiceApi = RegistryService.of({
  register: (repoPath, project) =>
    withDb("register repo", (db) => {
      const existing = db
        .query("SELECT * FROM registry WHERE repo_path = ?")
        .get(repoPath) as RegistryItem | null;

      if (existing) {
        if (existing.project !== project) {
          db.run("UPDATE registry SET project = ? WHERE repo_path = ?", [
            project,
            repoPath,
          ]);
        }
        return { ...existing, project };
      }

      const id = generateId();
      const created_at = Date.now();
      const item: RegistryItem = {
        id,
        repo_path: repoPath,
        project,
        created_at,
      };
      db.run(
        "INSERT INTO registry (id, repo_path, project, created_at) VALUES (?, ?, ?, ?)",
        [id, repoPath, project, created_at],
      );
      return item;
    }),

  unregister: (repoPath) =>
    withDb("unregister repo", (db) => {
      const result = db.run("DELETE FROM registry WHERE repo_path = ?", [
        repoPath,
      ]);
      return result.changes > 0;
    }),

  listRepos: () =>
    withDb("list repos", (db) => {
      return db
        .query("SELECT * FROM registry ORDER BY project ASC")
        .all() as RegistryItem[];
    }),

  findByPath: (repoPath) =>
    withDb("find repo", (db) => {
      return (
        (db
          .query("SELECT * FROM registry WHERE repo_path = ?")
          .get(repoPath) as RegistryItem | null) ?? null
      );
    }),
});

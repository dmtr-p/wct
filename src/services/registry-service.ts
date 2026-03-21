import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { Effect, ServiceMap } from "effect";
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

export const RegistryService = ServiceMap.Service<RegistryServiceApi>(
  "wct/RegistryService",
);

const REGISTRY_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS registry (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

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
      db.run(REGISTRY_SCHEMA_SQL);
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
    Effect.gen(function* () {
      const existing = yield* withDb("check existing", (db) => {
        return db
          .query("SELECT * FROM registry WHERE repo_path = ?")
          .get(repoPath) as RegistryItem | null;
      });

      if (existing) {
        // Update project name if changed
        if (existing.project !== project) {
          yield* withDb("update project", (db) => {
            db.run("UPDATE registry SET project = ? WHERE repo_path = ?", [
              project,
              repoPath,
            ]);
          });
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

      yield* withDb("register repo", (db) => {
        db.run(
          "INSERT INTO registry (id, repo_path, project, created_at) VALUES (?, ?, ?, ?)",
          [id, repoPath, project, created_at],
        );
      });

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

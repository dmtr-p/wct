import type { Database } from "bun:sqlite";
import { Context, type Effect } from "effect";
import type { WctError } from "../errors";
import { withDb } from "./db";

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

function generateId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function registryDb<A>(
  operation: string,
  f: (db: Database) => A,
): Effect.Effect<A, WctError> {
  return withDb("registry_error", operation, f);
}

export const liveRegistryService: RegistryServiceApi = RegistryService.of({
  register: (repoPath, project) =>
    registryDb("register repo", (db) => {
      const id = generateId();
      const now = Date.now();
      return db
        .query(
          `INSERT INTO registry (id, repo_path, project, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(repo_path) DO UPDATE SET project = excluded.project
           RETURNING *`,
        )
        .get(id, repoPath, project, now) as RegistryItem;
    }),

  unregister: (repoPath) =>
    registryDb("unregister repo", (db) => {
      const result = db.run("DELETE FROM registry WHERE repo_path = ?", [
        repoPath,
      ]);
      return result.changes > 0;
    }),

  listRepos: () =>
    registryDb("list repos", (db) => {
      return db
        .query("SELECT * FROM registry ORDER BY project ASC")
        .all() as RegistryItem[];
    }),

  findByPath: (repoPath) =>
    registryDb("find repo", (db) => {
      return (
        (db
          .query("SELECT * FROM registry WHERE repo_path = ?")
          .get(repoPath) as RegistryItem | null) ?? null
      );
    }),
});

import type { Database } from "bun:sqlite";
import { Context, type Effect } from "effect";
import type { WctError } from "../errors";
import { withDb } from "./db";
import { RegistrationId } from "./identities";

export interface RegistryItem {
  id: RegistrationId;
  repo_path: string;
  /** Project Display Name; membership is keyed by repo_path. */
  project: string;
  created_at: number;
}

export interface RegistryRegisterOptions {
  forceRename?: boolean;
}

export type RegistryRegistrationResult =
  | {
      status: "registered" | "already-registered";
      item: RegistryItem;
    }
  | {
      status: "updated";
      item: RegistryItem;
      previousItem: RegistryItem;
    };

export interface RegistryServiceApi {
  register: (
    repoPath: string,
    project: string,
    options?: RegistryRegisterOptions,
  ) => Effect.Effect<RegistryRegistrationResult, WctError>;
  unregister: (repoPath: string) => Effect.Effect<boolean, WctError>;
  listRepos: Effect.Effect<RegistryItem[], WctError>;
  findByPath: (
    repoPath: string,
  ) => Effect.Effect<RegistryItem | null, WctError>;
}

export const RegistryService = Context.Service<RegistryServiceApi>(
  "wct/RegistryService",
);

type RegistryRow = Omit<RegistryItem, "id"> & { id: string };

function hydrateRegistryItem(row: RegistryRow): RegistryItem {
  return { ...row, id: RegistrationId(row.id) };
}

function generateId(): RegistrationId {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return RegistrationId(`${ts}-${rand}`);
}

function registryDb<A>(
  operation: string,
  f: (db: Database) => A,
): Effect.Effect<A, WctError> {
  return withDb("registry_error", operation, f);
}

export const liveRegistryService: RegistryServiceApi = RegistryService.of({
  register: (repoPath, project, options) =>
    registryDb("register repo", (db) => {
      return db.transaction(() => {
        const id = generateId();
        const now = Date.now();
        const inserted =
          (db
            .query(
              `INSERT INTO registry (id, repo_path, project, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(repo_path) DO NOTHING
               RETURNING *`,
            )
            .get(id, repoPath, project, now) as RegistryRow | null) ?? null;

        if (inserted) {
          return {
            status: "registered",
            item: hydrateRegistryItem(inserted),
          } satisfies RegistryRegistrationResult;
        }

        const existing = hydrateRegistryItem(
          db
            .query("SELECT * FROM registry WHERE repo_path = ?")
            .get(repoPath) as RegistryRow,
        );

        if (options?.forceRename === true && existing.project !== project) {
          const item = db
            .query(
              `UPDATE registry
               SET project = ?
               WHERE repo_path = ?
               RETURNING *`,
            )
            .get(project, repoPath) as RegistryRow;
          return {
            status: "updated",
            item: hydrateRegistryItem(item),
            previousItem: existing,
          } satisfies RegistryRegistrationResult;
        }

        return {
          status: "already-registered",
          item: existing,
        } satisfies RegistryRegistrationResult;
      })();
    }),

  unregister: (repoPath) =>
    registryDb("unregister repo", (db) => {
      const result = db.run("DELETE FROM registry WHERE repo_path = ?", [
        repoPath,
      ]);
      return result.changes > 0;
    }),

  listRepos: registryDb("list repos", (db) => {
    const rows = db
      .query("SELECT * FROM registry ORDER BY project ASC")
      .all() as RegistryRow[];
    return rows.map(hydrateRegistryItem);
  }),

  findByPath: (repoPath) =>
    registryDb("find repo", (db) => {
      const row =
        (db
          .query("SELECT * FROM registry WHERE repo_path = ?")
          .get(repoPath) as RegistryRow | null) ?? null;
      return row ? hydrateRegistryItem(row) : null;
    }),
});

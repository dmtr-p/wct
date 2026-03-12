import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { Effect, ServiceMap } from "effect";
import { commandError, type WctError } from "../errors";
import * as logger from "../utils/logger";
import { isPaneAlive, listSessions } from "./tmux";

function getQueueDir(): string {
  return `${process.env.HOME ?? "/tmp"}/.wct`;
}

function getDbPath(): string {
  return `${getQueueDir()}/queue.db`;
}

export interface QueueItem {
  id: string;
  branch: string;
  project: string;
  type: string;
  message: string;
  session: string;
  pane: string;
  timestamp: number;
}

export interface ListItemsOptions {
  validatePanes?: boolean;
  logWarnings?: boolean;
}

export interface QueueStorageService {
  addItem: (
    item: Omit<QueueItem, "id" | "timestamp">,
  ) => Effect.Effect<QueueItem, WctError>;
  listItems: (
    options?: ListItemsOptions,
  ) => Effect.Effect<QueueItem[], WctError>;
  removeItem: (id: string) => Effect.Effect<boolean, WctError>;
  removeItemsBySession: (session: string) => Effect.Effect<number, WctError>;
  clearAll: () => Effect.Effect<number, WctError>;
}

export const QueueStorage =
  ServiceMap.Service<QueueStorageService>("wct/QueueStorage");

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS queue (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  session TEXT NOT NULL,
  pane TEXT NOT NULL UNIQUE,
  timestamp INTEGER NOT NULL
)`;

function generateId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function withDbSync<A>(
  operation: string,
  f: (db: Database) => A,
): Effect.Effect<A, WctError> {
  return Effect.try({
    try: () => {
      mkdirSync(getQueueDir(), { recursive: true });

      const db = new Database(getDbPath(), { create: true });
      db.run("PRAGMA journal_mode=WAL");
      db.run(SCHEMA_SQL);

      try {
        return f(db);
      } finally {
        db.close();
      }
    },
    catch: (error) =>
      commandError(
        "queue_error",
        `Queue database operation failed during ${operation}`,
        error,
      ),
  });
}

function deleteItemsByIds(ids: string[]): Effect.Effect<void, WctError> {
  if (ids.length === 0) {
    return Effect.void;
  }

  return withDbSync("delete stale queue items", (db) => {
    const placeholders = ids.map(() => "?").join(",");
    db.run(`DELETE FROM queue WHERE id IN (${placeholders})`, ids);
  });
}

export const liveQueueStorage: QueueStorageService = QueueStorage.of({
  addItem: (item) =>
    Effect.gen(function* () {
      const id = generateId();
      const timestamp = Date.now();
      const queueItem = { ...item, id, timestamp };

      yield* withDbSync("insert queue item", (db) => {
        db.run(
          `INSERT OR REPLACE INTO queue (id, branch, project, type, message, session, pane, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            item.branch,
            item.project,
            item.type,
            item.message,
            item.session,
            item.pane,
            timestamp,
          ],
        );
      });

      return queueItem;
    }),
  listItems: (options = {}) =>
    Effect.gen(function* () {
      const { validatePanes = true, logWarnings = true } = options;
      const rows = yield* withDbSync("read queue items", (db) => {
        return db
          .query("SELECT * FROM queue ORDER BY timestamp ASC")
          .all() as QueueItem[];
      });

      const sessionList = yield* Effect.tryPromise({
        try: () => listSessions(),
        catch: (error) =>
          commandError(
            "queue_error",
            "Failed to inspect tmux sessions for queue cleanup",
            error,
          ),
      });

      if (sessionList === null) {
        if (logWarnings && rows.length > 0) {
          yield* logger.warn(
            "Skipping queue stale cleanup because tmux sessions could not be determined",
          );
        }
        return rows;
      }

      const sessions = new Set(sessionList.map((session) => session.name));
      const live: QueueItem[] = [];
      const staleIds: string[] = [];

      for (const row of rows) {
        if (!sessions.has(row.session)) {
          staleIds.push(row.id);
          continue;
        }

        if (validatePanes) {
          const paneAlive = yield* Effect.tryPromise({
            try: () => isPaneAlive(row.pane),
            catch: (error) =>
              commandError(
                "queue_error",
                `Failed to inspect tmux pane '${row.pane}'`,
                error,
              ),
          });

          if (paneAlive === false) {
            staleIds.push(row.id);
            continue;
          }

          if (paneAlive === null && logWarnings) {
            yield* logger.warn(
              `Skipping pane liveness cleanup for queue item '${row.id}' because tmux pane '${row.pane}' could not be inspected`,
            );
          }
        }

        live.push(row);
      }

      if (staleIds.length > 0) {
        try {
          yield* deleteItemsByIds(staleIds);
        } catch (error) {
          yield* logger.warn(
            `Failed to remove stale queue items: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return live;
    }),
  removeItem: (id) =>
    withDbSync("remove queue item", (db) => {
      const result = db.run("DELETE FROM queue WHERE id = ?", [id]);
      return result.changes > 0;
    }),
  removeItemsBySession: (session) =>
    withDbSync("remove queue items by session", (db) => {
      const result = db.run("DELETE FROM queue WHERE session = ?", [session]);
      return result.changes;
    }),
  clearAll: () =>
    withDbSync("clear queue items", (db) => {
      const result = db.run("DELETE FROM queue");
      return result.changes;
    }),
});

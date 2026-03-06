import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as logger from "../utils/logger";
import { listSessions } from "./tmux";

function getQueueDir(): string {
  return join(process.env.HOME ?? "/tmp", ".wct");
}

function getDbPath(): string {
  return join(getQueueDir(), "queue.db");
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

function getDb(): Database {
  mkdirSync(getQueueDir(), { recursive: true });
  const db = new Database(getDbPath(), { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS queue (
    id TEXT PRIMARY KEY,
    branch TEXT NOT NULL,
    project TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    session TEXT NOT NULL,
    pane TEXT NOT NULL UNIQUE,
    timestamp INTEGER NOT NULL
  )`);
  return db;
}

function generateId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

export function addItem(item: Omit<QueueItem, "id" | "timestamp">): QueueItem {
  const db = getDb();
  const id = generateId();
  const timestamp = Date.now();
  const queueItem = { ...item, id, timestamp };

  try {
    // UNIQUE on pane means INSERT OR REPLACE removes the old item for that pane
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
  } finally {
    db.close();
  }

  return queueItem;
}

export async function listItems(): Promise<QueueItem[]> {
  const db = getDb();
  try {
    const rows = db
      .query("SELECT * FROM queue ORDER BY timestamp ASC")
      .all() as QueueItem[];

    const sessionList = await listSessions();
    if (sessionList === null) {
      if (rows.length > 0) {
        logger.warn(
          "Skipping queue stale cleanup because tmux sessions could not be determined",
        );
      }
      return rows;
    }

    const sessions = new Set(sessionList.map((s) => s.name));
    const live: QueueItem[] = [];
    const staleIds: string[] = [];

    for (const row of rows) {
      if (sessions.has(row.session)) {
        live.push(row);
      } else {
        staleIds.push(row.id);
      }
    }

    if (staleIds.length > 0) {
      try {
        const placeholders = staleIds.map(() => "?").join(",");
        db.run(`DELETE FROM queue WHERE id IN (${placeholders})`, staleIds);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to remove stale queue items: ${message}`);
      }
    }

    return live;
  } finally {
    db.close();
  }
}

export function removeItem(id: string): boolean {
  const db = getDb();
  let result: ReturnType<Database["run"]> | undefined;
  try {
    result = db.run("DELETE FROM queue WHERE id = ?", [id]);
  } finally {
    db.close();
  }
  return (result?.changes ?? 0) > 0;
}

export function removeItemsBySession(session: string): number {
  let db: Database | null = null;
  try {
    db = getDb();
    const result = db.run("DELETE FROM queue WHERE session = ?", [session]);
    return result.changes;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Failed to remove queued items for session '${session}': ${message}`,
    );
    return 0;
  } finally {
    db?.close();
  }
}

export function clearAll(): number {
  const db = getDb();
  let result: ReturnType<Database["run"]> | undefined;
  try {
    result = db.run("DELETE FROM queue");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to clear queue items: ${message}`);
    return 0;
  } finally {
    db.close();
  }
  return result?.changes ?? 0;
}

export function countItems(): number {
  const db = getDb();
  let row:
    | {
        count: number;
      }
    | undefined;
  try {
    row = db.query("SELECT COUNT(*) as count FROM queue").get() as {
      count: number;
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to count queue items: ${message}`);
    return 0;
  } finally {
    db.close();
  }
  return row?.count ?? 0;
}

export function formatCount(count: number): string {
  if (count === 0) return "";
  return `\u{1F514} ${count}`;
}

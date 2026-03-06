import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { listSessions } from "./tmux";

const QUEUE_DIR = join(process.env.HOME ?? "/tmp", ".wct");
const DB_PATH = join(QUEUE_DIR, "queue.db");

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
  mkdirSync(QUEUE_DIR, { recursive: true });
  const db = new Database(DB_PATH, { create: true });
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
  db.close();

  return { ...item, id, timestamp };
}

export async function listItems(): Promise<QueueItem[]> {
  const db = getDb();
  const rows = db
    .query("SELECT * FROM queue ORDER BY timestamp ASC")
    .all() as QueueItem[];

  const sessions = new Set((await listSessions()).map((s) => s.name));
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
    const placeholders = staleIds.map(() => "?").join(",");
    db.run(`DELETE FROM queue WHERE id IN (${placeholders})`, staleIds);
  }

  db.close();
  return live;
}

export function removeItem(id: string): boolean {
  const db = getDb();
  const result = db.run("DELETE FROM queue WHERE id = ?", [id]);
  db.close();
  return result.changes > 0;
}

export function removeItemsBySession(session: string): number {
  const db = getDb();
  const result = db.run("DELETE FROM queue WHERE session = ?", [session]);
  db.close();
  return result.changes;
}

export function clearAll(): number {
  const db = getDb();
  const result = db.run("DELETE FROM queue");
  db.close();
  return result.changes;
}

export function countItems(): number {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM queue").get() as {
    count: number;
  };
  db.close();
  return row.count;
}

export function formatCount(count: number): string {
  if (count === 0) return "";
  return `\u{1F514} ${count}`;
}

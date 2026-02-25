import { Database } from "bun:sqlite";

export function createTestDb(
  rows: { key: string; value: string }[],
  dbPath: string,
): void {
  const db = new Database(dbPath);
  db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  for (const row of rows) {
    insert.run(row.key, row.value);
  }
  db.close();
}

export function readAllKeys(dbPath: string): string[] {
  const db = new Database(dbPath);
  const rows = db.query("SELECT key FROM ItemTable").all() as {
    key: string;
  }[];
  db.close();
  return rows.map((r) => r.key);
}

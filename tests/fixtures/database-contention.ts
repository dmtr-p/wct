import { Database } from "bun:sqlite";
import type { EventEmitter } from "node:events";

const db = new Database(process.argv[2]);
try {
  db.run("PRAGMA journal_mode=DELETE");
  db.run("BEGIN EXCLUSIVE");
  await new Promise<void>((resolve) => {
    const events: EventEmitter = process;
    events.on("message", (message: unknown) => {
      if (message === "release") {
        // Release in this process while the reader is inside synchronous SQLite.
        setTimeout(resolve, 200);
      }
    });
    process.send?.("locked");
  });
  db.run("COMMIT");
} finally {
  db.close();
  if (process.connected) process.disconnect?.();
}

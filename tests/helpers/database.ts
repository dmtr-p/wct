import { Database } from "bun:sqlite";
import { test as base } from "vitest";

export async function databaseFixture(
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest requires destructuring even without dependencies.
  {}: object,
  use: (database: Database) => Promise<void>,
) {
  const database = new Database(":memory:");
  try {
    await use(database);
  } finally {
    database.close();
  }
}

export const test = base.extend<{ db: Database }>({
  db: databaseFixture,
});

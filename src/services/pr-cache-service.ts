import type { Database } from "bun:sqlite";
import { Context, type Effect } from "effect";
import type { WctError } from "../errors";
import type { PRInfo } from "../tui/types";
import { withDb } from "./db";

export interface CachedPrEntry {
  payload: PRInfo[];
  fetchedAt: number;
  lastError: string | null;
}

export interface PrCacheServiceApi {
  getCached: (project: string) => Effect.Effect<CachedPrEntry | null, WctError>;
  setCached: (
    project: string,
    payload: PRInfo[],
  ) => Effect.Effect<void, WctError>;
  setError: (project: string, error: string) => Effect.Effect<void, WctError>;
  invalidate: (project: string) => Effect.Effect<void, WctError>;
}

export const PrCacheService =
  Context.Service<PrCacheServiceApi>("wct/PrCacheService");

// ---------------------------------------------------------------------------
// Internal SQL helpers — exported so tests can call them directly on a
// `:memory:` Database without going through `withDb`.
// ---------------------------------------------------------------------------

interface RawCacheRow {
  project: string;
  payload: string;
  fetched_at: number;
  last_error: string | null;
}

export function sqlGetCached(
  db: Database,
  project: string,
): CachedPrEntry | null {
  const row = db
    .query(
      "SELECT payload, fetched_at, last_error FROM pr_cache WHERE project = ?",
    )
    .get(project) as RawCacheRow | null;
  if (row === null) return null;
  let parsed: PRInfo[];
  try {
    parsed = JSON.parse(row.payload) as PRInfo[];
  } catch {
    parsed = [];
  }
  return {
    payload: parsed,
    fetchedAt: row.fetched_at,
    lastError: row.last_error ?? null,
  };
}

export function sqlSetCached(
  db: Database,
  project: string,
  payload: PRInfo[],
): void {
  db.run(
    `INSERT OR REPLACE INTO pr_cache (project, payload, fetched_at, last_error)
     VALUES (?, ?, ?, NULL)`,
    [project, JSON.stringify(payload), Date.now()],
  );
}

export function sqlSetError(
  db: Database,
  project: string,
  error: string,
): void {
  // Update last_error but keep existing payload/fetched_at if a row exists;
  // if no row exists yet, insert a sentinel with empty payload so we can
  // record the error without fabricating a fetched_at.
  db.run(
    `INSERT INTO pr_cache (project, payload, fetched_at, last_error)
       VALUES (?, '[]', 0, ?)
     ON CONFLICT(project) DO UPDATE SET last_error = excluded.last_error`,
    [project, error],
  );
}

export function sqlInvalidate(db: Database, project: string): void {
  db.run("DELETE FROM pr_cache WHERE project = ?", [project]);
}

// ---------------------------------------------------------------------------
// Live service implementation
// ---------------------------------------------------------------------------

function prCacheDb<A>(
  operation: string,
  f: (db: Database) => A,
): Effect.Effect<A, WctError> {
  return withDb("pr_cache_error", operation, f);
}

export const livePrCacheService: PrCacheServiceApi = PrCacheService.of({
  getCached: (project) =>
    prCacheDb("getCached", (db) => sqlGetCached(db, project)),

  setCached: (project, payload) =>
    prCacheDb("setCached", (db) => sqlSetCached(db, project, payload)),

  setError: (project, error) =>
    prCacheDb("setError", (db) => sqlSetError(db, project, error)),

  invalidate: (project) =>
    prCacheDb("invalidate", (db) => sqlInvalidate(db, project)),
});

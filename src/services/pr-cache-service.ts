import type { Database } from "bun:sqlite";
import { Context, type Effect } from "effect";
import type { WctError } from "../errors";
import type { PRInfo } from "../tui/types";
import { withDb } from "./db";
import { hydratePrFacts, type PrFacts } from "./pr-model";

export interface CachedPrEntry {
  payload: PRInfo[];
  fetchedAt: number;
  lastError: string | null;
}

export interface WorkspacePrEntry {
  pr: PrFacts | null;
  candidates: PrFacts[];
  newerOpenPr: number | null;
  uncertain: boolean;
  explicit?: boolean;
  fetchedAt: number;
  lastError: string | null;
}

export interface ExplicitPrAssociation {
  baseRepository: string;
  number: number;
}

export interface PrCacheServiceApi {
  /** Clear a repository's cached PR payloads, retaining Explicit PR Associations. */
  invalidate: (repoPath: string) => Effect.Effect<void, WctError>;
  getWorkspace: (
    repoPath: string,
    branch: string,
  ) => Effect.Effect<WorkspacePrEntry | null, WctError>;
  setWorkspace: (
    repoPath: string,
    branch: string,
    entry: WorkspacePrEntry,
  ) => Effect.Effect<void, WctError>;
  setWorkspaceError: (
    repoPath: string,
    branch: string,
    error: string,
  ) => Effect.Effect<void, WctError>;
  pruneWorkspaces: (
    repoPath: string,
    presentBranches: string[],
  ) => Effect.Effect<void, WctError>;
  getExplicit: (
    repoPath: string,
    branch: string,
  ) => Effect.Effect<ExplicitPrAssociation | null, WctError>;
  setExplicit: (
    repoPath: string,
    branch: string,
    association: ExplicitPrAssociation,
  ) => Effect.Effect<void, WctError>;
  clearExplicit: (
    repoPath: string,
    branch: string,
  ) => Effect.Effect<void, WctError>;
  getOpenPrs: (
    repoPath: string,
  ) => Effect.Effect<CachedPrEntry | null, WctError>;
  setOpenPrs: (
    repoPath: string,
    prs: PRInfo[],
  ) => Effect.Effect<void, WctError>;
}

export const PrCacheService =
  Context.Service<PrCacheServiceApi>("wct/PrCacheService");

// ---------------------------------------------------------------------------
// Internal SQL helpers — exported so tests can call them directly on a
// `:memory:` Database without going through `withDb`.
// ---------------------------------------------------------------------------

export function sqlInvalidate(db: Database, repoPath: string): void {
  db.transaction(() => {
    db.run("DELETE FROM workspace_pr_cache WHERE repo_path = ?", [repoPath]);
    db.run("DELETE FROM open_pr_cache WHERE repo_path = ?", [repoPath]);
  }).immediate();
}

export function sqlGetWorkspace(
  db: Database,
  repoPath: string,
  branch: string,
): WorkspacePrEntry | null {
  const row = db
    .query(
      "SELECT payload, fetched_at, last_error FROM workspace_pr_cache WHERE repo_path = ? AND branch = ?",
    )
    .get(repoPath, branch) as {
    payload: string;
    fetched_at: number;
    last_error: string | null;
  } | null;
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    /* malformed cache stays unknown */
  }
  return {
    pr: hydratePrFacts(payload.pr),
    candidates: Array.isArray(payload.candidates)
      ? payload.candidates
          .map(hydratePrFacts)
          .filter((p): p is PrFacts => p !== null)
      : [],
    newerOpenPr:
      typeof payload.newerOpenPr === "number" ? payload.newerOpenPr : null,
    uncertain: payload.uncertain === true,
    explicit: payload.explicit === true,
    fetchedAt: row.fetched_at,
    lastError: row.last_error,
  };
}

export function sqlSetWorkspace(
  db: Database,
  repoPath: string,
  branch: string,
  entry: WorkspacePrEntry,
): void {
  db.run(
    `INSERT INTO workspace_pr_cache (repo_path, branch, payload, fetched_at, last_error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repo_path, branch) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, last_error = excluded.last_error`,
    [
      repoPath,
      branch,
      JSON.stringify({
        pr: entry.pr,
        candidates: entry.candidates,
        newerOpenPr: entry.newerOpenPr,
        uncertain: entry.uncertain,
        explicit: entry.explicit,
      }),
      entry.fetchedAt,
      entry.lastError,
    ],
  );
}

export function sqlSetWorkspaceError(
  db: Database,
  repoPath: string,
  branch: string,
  error: string,
): void {
  db.run(
    `INSERT INTO workspace_pr_cache (repo_path, branch, payload, fetched_at, last_error)
    VALUES (?, ?, '{}', 0, ?)
    ON CONFLICT(repo_path, branch) DO UPDATE SET last_error = excluded.last_error`,
    [repoPath, branch, error],
  );
}

/** Called only after a complete, non-aborted repository scan. */
export function sqlPruneWorkspaces(
  db: Database,
  repoPath: string,
  presentBranches: readonly string[],
): void {
  db.transaction(() => {
    const present = new Set(presentBranches);
    const rows = db
      .query("SELECT branch FROM workspace_pr_cache WHERE repo_path = ?")
      .all(repoPath) as { branch: string }[];
    for (const row of rows) {
      if (!present.has(row.branch))
        db.run(
          "DELETE FROM workspace_pr_cache WHERE repo_path = ? AND branch = ?",
          [repoPath, row.branch],
        );
    }
    const associations = db
      .query("SELECT branch FROM workspace_pr_association WHERE repo_path = ?")
      .all(repoPath) as { branch: string }[];
    for (const row of associations) {
      if (!present.has(row.branch))
        db.run(
          "DELETE FROM workspace_pr_association WHERE repo_path = ? AND branch = ?",
          [repoPath, row.branch],
        );
    }
  }).immediate();
}

export function sqlGetExplicit(
  db: Database,
  repoPath: string,
  branch: string,
): ExplicitPrAssociation | null {
  const row = db
    .query(
      "SELECT base_repository, pr_number FROM workspace_pr_association WHERE repo_path = ? AND branch = ?",
    )
    .get(repoPath, branch) as {
    base_repository: string;
    pr_number: number;
  } | null;
  return row
    ? { baseRepository: row.base_repository, number: row.pr_number }
    : null;
}

export function sqlSetExplicit(
  db: Database,
  repoPath: string,
  branch: string,
  association: ExplicitPrAssociation,
): void {
  db.run(
    `INSERT INTO workspace_pr_association (repo_path, branch, base_repository, pr_number) VALUES (?, ?, ?, ?)
    ON CONFLICT(repo_path, branch) DO UPDATE SET base_repository = excluded.base_repository, pr_number = excluded.pr_number`,
    [repoPath, branch, association.baseRepository, association.number],
  );
}

export function sqlClearExplicit(
  db: Database,
  repoPath: string,
  branch: string,
): void {
  db.run(
    "DELETE FROM workspace_pr_association WHERE repo_path = ? AND branch = ?",
    [repoPath, branch],
  );
}

export function sqlGetOpenPrs(
  db: Database,
  repoPath: string,
): CachedPrEntry | null {
  const row = db
    .query(
      "SELECT payload, fetched_at, last_error FROM open_pr_cache WHERE repo_path = ?",
    )
    .get(repoPath) as {
    payload: string;
    fetched_at: number;
    last_error: string | null;
  } | null;
  if (!row) return null;
  let payload: PRInfo[] = [];
  try {
    const parsed = JSON.parse(row.payload);
    if (Array.isArray(parsed))
      payload = parsed.filter((pr) => pr?.state === "OPEN");
  } catch {
    /* malformed cache is empty */
  }
  return { payload, fetchedAt: row.fetched_at, lastError: row.last_error };
}

export function sqlSetOpenPrs(
  db: Database,
  repoPath: string,
  prs: PRInfo[],
): void {
  db.run(
    `INSERT INTO open_pr_cache (repo_path, payload, fetched_at, last_error) VALUES (?, ?, ?, NULL)
    ON CONFLICT(repo_path) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, last_error = NULL`,
    [
      repoPath,
      JSON.stringify(prs.filter((pr) => pr.state === "OPEN")),
      Date.now(),
    ],
  );
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
  invalidate: (repoPath) =>
    prCacheDb("invalidate", (db) => sqlInvalidate(db, repoPath)),
  getWorkspace: (repoPath, branch) =>
    prCacheDb("getWorkspace", (db) => sqlGetWorkspace(db, repoPath, branch)),
  setWorkspace: (repoPath, branch, entry) =>
    prCacheDb("setWorkspace", (db) =>
      sqlSetWorkspace(db, repoPath, branch, entry),
    ),
  setWorkspaceError: (repoPath, branch, error) =>
    prCacheDb("setWorkspaceError", (db) =>
      sqlSetWorkspaceError(db, repoPath, branch, error),
    ),
  pruneWorkspaces: (repoPath, branches) =>
    prCacheDb("pruneWorkspaces", (db) =>
      sqlPruneWorkspaces(db, repoPath, branches),
    ),
  getExplicit: (repoPath, branch) =>
    prCacheDb("getExplicit", (db) => sqlGetExplicit(db, repoPath, branch)),
  setExplicit: (repoPath, branch, association) =>
    prCacheDb("setExplicit", (db) =>
      sqlSetExplicit(db, repoPath, branch, association),
    ),
  clearExplicit: (repoPath, branch) =>
    prCacheDb("clearExplicit", (db) => sqlClearExplicit(db, repoPath, branch)),
  getOpenPrs: (repoPath) =>
    prCacheDb("getOpenPrs", (db) => sqlGetOpenPrs(db, repoPath)),
  setOpenPrs: (repoPath, prs) =>
    prCacheDb("setOpenPrs", (db) => sqlSetOpenPrs(db, repoPath, prs)),
});

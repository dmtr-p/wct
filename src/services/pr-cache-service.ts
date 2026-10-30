import type { Database } from "bun:sqlite";
import { Context, Effect } from "effect";
import type { WctError } from "../errors";
import { withDb, withDbEffect } from "./db";
import {
  hydratePrFacts,
  type OpenPrChoice,
  type PrFacts,
  prIdentity,
} from "./pr-model";

export interface CachedPrEntry {
  payload: OpenPrChoice[];
  fetchedAt: number;
  lastError: string | null;
}

export interface PrDiscoverySnapshot {
  baseRepository: string;
  prs: PrFacts[];
  explicitPrs: PrFacts[];
  openNumbers: number[];
  fetchedAt: number;
  discoveredThrough: number;
}

export interface WorkspacePrEntry {
  pr: PrFacts | null;
  candidates: PrFacts[];
  newerOpenPr: number | null;
  explicit?: boolean;
  fetchedAt: number;
  lastError: string | null;
}

export interface ExplicitPrAssociation {
  baseRepository: string;
  number: number;
}

export interface WorkspacePrInput {
  branch: string;
  explicit: ExplicitPrAssociation | null;
  cached: WorkspacePrEntry | null;
}

export interface PrCacheServiceApi {
  getWorkspaceInputs: (
    repoPath: string,
    branches: readonly string[],
  ) => Effect.Effect<WorkspacePrInput[], WctError>;
  getDiscovery: (
    repoPath: string,
  ) => Effect.Effect<PrDiscoverySnapshot | null, WctError>;
  setDiscovery: (
    repoPath: string,
    snapshot: PrDiscoverySnapshot,
    previous?: PrDiscoverySnapshot | null,
    registrationId?: string,
  ) => Effect.Effect<boolean, WctError>;
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
    registrationId?: string,
  ) => Effect.Effect<void, WctError>;
  setWorkspaceError: (
    repoPath: string,
    branch: string,
    error: string,
    registrationId?: string,
  ) => Effect.Effect<void, WctError>;
  pruneWorkspaces: (
    repoPath: string,
    presentBranches: string[],
    registrationId?: string,
  ) => Effect.Effect<void, WctError>;
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
    prs: OpenPrChoice[],
    registrationId?: string,
  ) => Effect.Effect<void, WctError>;
}

export const PrCacheService =
  Context.Service<PrCacheServiceApi>("wct/PrCacheService");

// Export SQL helpers so tests can use an in-memory database without withDb.
const discoveryVersions = new WeakMap<PrDiscoverySnapshot, string>();

export function sqlInvalidate(db: Database, repoPath: string): void {
  db.transaction(() => {
    db.run("DELETE FROM workspace_pr_cache WHERE repo_path = ?", [repoPath]);
    db.run("DELETE FROM open_pr_cache WHERE repo_path = ?", [repoPath]);
    db.run("DELETE FROM pr_discovery_cache WHERE repo_path = ?", [repoPath]);
    db.run("DELETE FROM pr_discovery_facts WHERE repo_path = ?", [repoPath]);
  }).immediate();
}

/** Fence writes against removal/re-registration in the same database transaction. */
export function sqlOwnedWrite(
  db: Database,
  repoPath: string,
  registrationId: string | undefined,
  write: () => void,
): boolean {
  return db
    .transaction(() => {
      if (
        registrationId !== undefined &&
        !db
          .query("SELECT 1 FROM registry WHERE repo_path = ? AND id = ?")
          .get(repoPath, registrationId)
      )
        return false;
      write();
      return true;
    })
    .immediate();
}

export function sqlGetDiscovery(
  db: Database,
  repoPath: string,
): PrDiscoverySnapshot | null {
  return db
    .transaction(() => {
      const reader = readDiscovery(db, repoPath);
      let next = reader.next();
      while (!next.done) next = reader.next();
      return next.value;
    })
    .deferred();
}

function* readDiscovery(
  db: Database,
  repoPath: string,
): Generator<void, PrDiscoverySnapshot | null> {
  const row = db
    .query("SELECT payload FROM pr_discovery_cache WHERE repo_path = ?")
    .get(repoPath) as { payload: string } | null;
  if (!row) return null;
  try {
    const metadata = JSON.parse(row.payload) as {
      format?: number;
      baseRepository?: string;
      fetchedAt?: number;
      discoveredThrough?: number;
    } | null;
    if (
      metadata?.format !== 2 ||
      typeof metadata.baseRepository !== "string" ||
      typeof metadata.fetchedAt !== "number" ||
      typeof metadata.discoveredThrough !== "number"
    )
      return null;
    const rows = db
      .query(
        "SELECT payload FROM pr_discovery_facts WHERE repo_path = ? ORDER BY pr_identity",
      )
      .iterate(repoPath) as IterableIterator<{ payload: string }>;
    const baseRepository = metadata.baseRepository.toLowerCase();
    const prs: PrFacts[] = [];
    const explicitPrs: PrFacts[] = [];
    let count = 0;
    for (const row of rows) {
      const pr = hydratePrFacts(JSON.parse(row.payload));
      if (!pr) return null;
      pr.baseRepository = pr.baseRepository.toLowerCase();
      if (pr.baseRepository === baseRepository) prs.push(pr);
      else explicitPrs.push(pr);
      if (++count % 128 === 0) yield;
    }
    const snapshot: PrDiscoverySnapshot = {
      baseRepository,
      prs,
      explicitPrs,
      openNumbers: prs
        .filter((pr) => pr.state === "OPEN")
        .map((pr) => pr.number),
      fetchedAt: metadata.fetchedAt,
      discoveredThrough: metadata.discoveredThrough,
    };
    discoveryVersions.set(snapshot, row.payload);
    return snapshot;
  } catch {
    return null;
  }
}

/** A single read transaction keeps metadata and streamed facts at one revision. */
export function sqlGetDiscoveryEffect(db: Database, repoPath: string) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      db.run("BEGIN DEFERRED");
      return readDiscovery(db, repoPath);
    }),
    (reader) =>
      Effect.gen(function* () {
        let next = reader.next();
        while (!next.done) {
          yield* Effect.sleep("1 millis");
          next = reader.next();
        }
        return next.value;
      }),
    (reader) =>
      Effect.sync(() => {
        reader.return(null);
        db.run("ROLLBACK");
      }),
  );
}

export function sqlSetDiscovery(
  db: Database,
  repoPath: string,
  snapshot: PrDiscoverySnapshot,
  previous: PrDiscoverySnapshot | null = null,
  registrationId?: string,
): boolean {
  return sqlOwnedWrite(db, repoPath, registrationId, () => {
    const stored = db
      .query("SELECT payload FROM pr_discovery_cache WHERE repo_path = ?")
      .get(repoPath) as { payload: string } | null;
    const old =
      previous &&
      stored &&
      discoveryVersions.get(previous) === stored.payload &&
      previous.baseRepository.toLowerCase() ===
        snapshot.baseRepository.toLowerCase()
        ? new Map(
            [...previous.prs, ...previous.explicitPrs].map((pr) => [
              prIdentity(pr),
              pr,
            ]),
          )
        : new Map<string, PrFacts>();
    let factsChanged = false;
    if (!old.size)
      factsChanged =
        db.run("DELETE FROM pr_discovery_facts WHERE repo_path = ?", [repoPath])
          .changes > 0;
    const present = new Set<string>();
    for (const pr of [...snapshot.prs, ...snapshot.explicitPrs]) {
      const identity = prIdentity(pr);
      present.add(identity);
      if (old.get(identity) === pr) continue;
      const payload = JSON.stringify(pr);
      const written = db.run(
        `INSERT INTO pr_discovery_facts (repo_path, pr_identity, payload) VALUES (?, ?, ?)
        ON CONFLICT(repo_path, pr_identity) DO UPDATE SET payload = excluded.payload WHERE payload <> excluded.payload`,
        [repoPath, identity, payload],
      );
      factsChanged ||= written.changes > 0;
    }
    for (const identity of old.keys())
      if (!present.has(identity))
        factsChanged =
          db.run(
            "DELETE FROM pr_discovery_facts WHERE repo_path = ? AND pr_identity = ?",
            [repoPath, identity],
          ).changes > 0 || factsChanged;
    const metadata = {
      format: 2,
      baseRepository: snapshot.baseRepository.toLowerCase(),
      fetchedAt: snapshot.fetchedAt,
      discoveredThrough: snapshot.discoveredThrough,
    };
    let revision: string | undefined;
    try {
      const current = JSON.parse(stored?.payload ?? "null");
      if (
        !factsChanged &&
        current &&
        Object.entries(metadata).every(([key, value]) => current[key] === value)
      )
        revision = current.revision;
    } catch {
      /* Invalid metadata is replaced with a complete snapshot. */
    }
    const payload = JSON.stringify({
      ...metadata,
      revision: revision ?? crypto.randomUUID(),
    });
    if (stored?.payload !== payload)
      db.run(
        `INSERT INTO pr_discovery_cache (repo_path, payload) VALUES (?, ?)
      ON CONFLICT(repo_path) DO UPDATE SET payload = excluded.payload`,
        [repoPath, payload],
      );
    discoveryVersions.set(snapshot, payload);
  });
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
  let payload: OpenPrChoice[] = [];
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
  prs: OpenPrChoice[],
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

function prCacheDb<A>(
  operation: string,
  f: (db: Database) => A,
): Effect.Effect<A, WctError> {
  return withDb("pr_cache_error", operation, f);
}

export const livePrCacheService: PrCacheServiceApi = PrCacheService.of({
  getWorkspaceInputs: (repoPath, branches) =>
    prCacheDb("getWorkspaceInputs", (db) =>
      db
        .transaction(() =>
          branches.map((branch) => ({
            branch,
            explicit: sqlGetExplicit(db, repoPath, branch),
            cached: sqlGetWorkspace(db, repoPath, branch),
          })),
        )
        .deferred(),
    ),
  getDiscovery: (repoPath) =>
    withDbEffect("pr_cache_error", "getDiscovery", (db) =>
      sqlGetDiscoveryEffect(db, repoPath),
    ),
  setDiscovery: (repoPath, snapshot, previous, registrationId) =>
    prCacheDb("setDiscovery", (db) =>
      sqlSetDiscovery(db, repoPath, snapshot, previous, registrationId),
    ),
  invalidate: (repoPath) =>
    prCacheDb("invalidate", (db) => sqlInvalidate(db, repoPath)),
  getWorkspace: (repoPath, branch) =>
    prCacheDb("getWorkspace", (db) => sqlGetWorkspace(db, repoPath, branch)),
  setWorkspace: (repoPath, branch, entry, registrationId) =>
    prCacheDb("setWorkspace", (db) => {
      sqlOwnedWrite(db, repoPath, registrationId, () =>
        sqlSetWorkspace(db, repoPath, branch, entry),
      );
    }),
  setWorkspaceError: (repoPath, branch, error, registrationId) =>
    prCacheDb("setWorkspaceError", (db) => {
      sqlOwnedWrite(db, repoPath, registrationId, () =>
        sqlSetWorkspaceError(db, repoPath, branch, error),
      );
    }),
  pruneWorkspaces: (repoPath, branches, registrationId) =>
    prCacheDb("pruneWorkspaces", (db) => {
      sqlOwnedWrite(db, repoPath, registrationId, () =>
        sqlPruneWorkspaces(db, repoPath, branches),
      );
    }),
  setExplicit: (repoPath, branch, association) =>
    prCacheDb("setExplicit", (db) =>
      sqlSetExplicit(db, repoPath, branch, association),
    ),
  clearExplicit: (repoPath, branch) =>
    prCacheDb("clearExplicit", (db) => sqlClearExplicit(db, repoPath, branch)),
  getOpenPrs: (repoPath) =>
    prCacheDb("getOpenPrs", (db) => sqlGetOpenPrs(db, repoPath)),
  setOpenPrs: (repoPath, prs, registrationId) =>
    prCacheDb("setOpenPrs", (db) => {
      sqlOwnedWrite(db, repoPath, registrationId, () =>
        sqlSetOpenPrs(db, repoPath, prs),
      );
    }),
});

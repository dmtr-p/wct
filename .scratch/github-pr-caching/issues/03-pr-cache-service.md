# `PrCacheService` + persistent TUI cache

Status: ready-for-agent

## Parent

[PRD: GitHub PR Data Caching & Refresh Refactor](../PRD.md)

## What to build

Add a v2 schema migration introducing a `pr_cache(project, payload, fetched_at, last_error)` table. The `payload` column stores a JSON-serialized array of `PRInfo` (number, title, state, headRefName, rollupState); writes are atomic single-statement `INSERT OR REPLACE`. An empty result is stored as `payload = "[]"` — a valid cached response, distinct from "never fetched".

Provide a new Effect service `PrCacheService` with the public surface `getCached(project)`, `setCached(project, payload)`, `setError(project, error)`, `invalidate(project)`. SQL, JSON serialization, and connection details are encapsulated. The service is registered in both the TUI runtime layer and the CLI services layer (the latter is needed for the `projects remove` cleanup path; cost is negligible since the DB connection is opened lazily on first use).

Wire `useGitHub` to read from the cache synchronously on mount and use the result as initial state — the tree view renders before any network call returns. After every successful fetch, write the payload to the cache and clear `last_error`. After a failed fetch, write `last_error` and leave the previous payload intact. At startup, for each repo whose cached `fetched_at` is younger than 30 seconds, skip the initial refetch (debounce against rapid relaunches).

The cache serves the TUI only. The CLI flow `wct open <pr-number>` (which goes through `resolvePr` → `gh pr view`) does not consult or write the cache; CLI behavior is unchanged.

## Acceptance criteria

- [ ] Re-launching the TUI shows PR decoration immediately, before any network call returns (story 1)
- [ ] Cache persists across TUI restarts; first launch of the day reads what the previous session wrote (story 2)
- [ ] Relaunching within 30 seconds of the last fetch skips the initial refetch for that repo (story 3)
- [ ] Two `wct tui` instances sharing the same DB file do not corrupt each other's cache writes (story 25)
- [ ] A failed fetch does not blank the tree view; the previous payload remains visible
- [ ] A successful fetch clears any previously-stored `last_error` for that repo
- [ ] An empty PR list round-trips as `[]` and is treated as a valid cache (distinct from `null`)
- [ ] `PrCacheService` is registered in both the TUI runtime layer and the CLI services layer
- [ ] CLI `wct open <pr-number>` still calls `gh pr view` directly and does not consult the cache (story 28)
- [ ] `PrCacheService` unit tests (against `:memory:` SQLite) cover: empty DB → `null`; round-trip via `setCached` / `getCached`; `invalidate` removes the row; `setError` then `getCached` reflects `last_error`; subsequent `setCached` clears `last_error`; empty array round-trips distinct from `null`; concurrent writes from two services on the same DB file produce well-formed observable rows

## Blocked by

- #01 (`PRInfo` shape change — the cache stores `PRInfo` with `rollupState`)
- #02 (the v2 migration is registered through the shared `wct-db` framework)

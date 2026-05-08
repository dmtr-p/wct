# GitHub PR Data Caching & Refresh Refactor

Status: ready-for-agent

## Problem Statement

When `wct tui` is open, the user constantly hits GitHub API rate limits. Every 30 seconds the TUI refetches PR data for every registered repository: one `gh pr list` per repo, plus *one `gh pr checks` call per PR returned* (an N+1 fan-out). With even a modest number of repos and PRs, the user blows through the authenticated REST limit within an hour and the PR decoration in the tree view stops working until the limit resets.

On top of that, the per-check rows that this expensive fetch enables — one row per CI/Actions job under each PR — are noisy and not useful. Users glance at the tree view to see *if* a PR is green, not to read every check name.

The current implementation also has no persistence: every TUI launch starts with an empty PR data map, blocking on the first round of fetches before any decoration appears, and any work the previous session did is thrown away on exit.

## Solution

From the user's perspective:

- Each PR shows a single rolled-up status icon (`✓`/`✗`/`◌`) next to the title, matching what github.com shows on the same PR. The per-check rows are removed.
- Opening the TUI is instant. Cached PR data renders before any network call returns; a background refresh updates the display as it completes.
- Background refresh runs at a slower cadence (~2 minutes) and the user can press `r` to force-refresh the focused repo. A small `↻` indicator next to the repo header shows when a fetch is in flight.
- The OpenModal's PR picker opens instantly from cache and silently refreshes that one repo behind the scenes; the user can also press a "Refresh" row pinned at the bottom of the picker to trigger an explicit reload.
- When the `gh` CLI is broken (auth expired, network error), the TUI surfaces a `⚠` next to affected repos and a one-line error in the status bar, while continuing to display the last-known-good cached data instead of going blank. When `gh` is simply not installed, the TUI stays silent — that's a configuration choice, not a failure.
- Cached data persists across TUI restarts. Removing a project from the registry (`wct projects remove`) also removes its cached PR data so the cache stays consistent with the user's current set of tracked projects.

The CLI commands (e.g. `wct open <pr-number>`) are unchanged — they continue to query GitHub directly, so their behavior is independent of TUI state.

## User Stories

1. As a TUI user, I want the tree view to render PR decoration instantly when I open the TUI, so I don't stare at a blank tree view while waiting for `gh` to return.
2. As a TUI user, I want PR data to survive across TUI restarts, so the first launch of the day is instant, not just relaunches within the same session.
3. As a TUI user who quickly closes and reopens the TUI, I want the on-startup refetch to be skipped if my cache is fresher than 30 seconds, so I don't hammer the API on every relaunch.
4. As a TUI user, I want a single `✓`/`✗`/`◌` icon next to each PR title, so I can see at a glance whether the PR's CI is passing, failing, or in progress.
5. As a TUI user, I want the rollup icon to match what I'd see on github.com for the same PR, so the icon is trustworthy and I don't have to second-guess it.
6. As a TUI user, I want PRs with no CI checks configured to show no icon at all, so I'm not misled into thinking they're "passing" when there's nothing to pass.
7. As a TUI user, I want PRs whose only non-success states are `SKIPPED`/`NEUTRAL`/`CANCELLED` to still show a green ✓, so path-filtered or intentionally-skipped jobs don't paint every PR red.
8. As a TUI user, I want the per-check rows under each PR removed, since they were noisy and rarely useful.
9. As a TUI user, I want background refresh to happen every ~2 minutes per repo, so my data is reasonably current without me having to remember to refresh manually.
10. As a TUI user, I want to press `r` to manually refresh PR data, so I can pull fresh data right after pushing or merging without waiting for the next background tick.
11. As a TUI user, I want `r` to refresh only the focused repo, not every registered repo, so I don't waste API calls or wait for unrelated repos to complete.
12. As a TUI user, I want a small `↻` indicator next to a repo header while a fetch for that repo is in flight, so I have ambient feedback that the data is updating.
13. As a TUI user, I want the same `↻` indicator to appear during background polls and during my explicit `r` refreshes, so the feedback is consistent regardless of trigger.
14. As a TUI user, I want the OpenModal's PR picker to open instantly with whatever's in the cache, so picking a PR feels snappy.
15. As a TUI user, I want a fresh fetch to kick off automatically when I open the OpenModal, so the picker silently reconciles to current data within a second of being on screen.
16. As a TUI user, I want a "Refresh" row pinned at the bottom of the OpenModal's PR picker, so I have a discoverable way to explicitly reload without leaving the modal.
17. As a TUI user, I want the Refresh row's label to flip to "↻ Loading..." and become non-selectable while a fetch is in flight, so I have clear feedback that my refresh registered.
18. As a TUI user, I want the modal's PR list to keep showing the last-known PRs while a refresh is in flight, so I can keep scrolling/searching without the list jumping or going blank.
19. As a TUI user, I want pressing `Esc` in the modal mid-refresh to cancel the in-flight fetch, so I don't leave stray `gh` subprocesses running after I've moved on.
20. As a TUI user, I want a small `↻ Updating…` indicator visible in the modal header while any modal-scoped fetch is in flight, so I have one consistent feedback signal across explicit and background refreshes.
21. As a TUI user without `gh` installed, I want the TUI to remain silent about PR data (no warnings, no error indicators), so I'm not bothered with messages about a feature I'm not using.
22. As a TUI user with `gh` installed but in a broken state (expired auth, network blip, repo not accessible), I want a `⚠` next to the affected repo and a one-line error in the status bar, so I notice that my data is stale and I know what to fix.
23. As a TUI user with `gh` broken, I want my cached PR data to keep displaying as last-known-good, so I'm not stranded with no information just because my last fetch failed.
24. As a TUI user who triggers a refresh while another refresh for the same repo is already in flight, I want both triggers to share the same fetch result, so I don't fire redundant `gh` calls and waste API quota.
25. As a TUI user running two `wct tui` instances simultaneously, I want them to share the cache safely, so concurrent use doesn't corrupt my data.
26. As a project maintainer running `wct projects remove <repo>`, I want the cached PR data for that repo to be removed in the same operation, so my cache stays consistent with my current registry.
27. As a project maintainer who re-adds a previously-removed project, I want the next TUI launch to fetch fresh data rather than display ancient cached PRs from the prior registration.
28. As a CLI user invoking `wct open <pr-number>` outside the TUI, I want the command to behave exactly as it does today (fresh `gh pr view` lookup), so my CLI workflow is independent of TUI state.
29. As a developer maintaining the codebase, I want the cache layer isolated in its own service, so I can reason about it, test it, and replace its storage without touching the GitHub-fetching path or the registry.
30. As a developer, I want the SQLite migration framework to be a single source of truth shared across services, so adding a v3 in the future doesn't require updating two places.

## Implementation Decisions

### Removed surface

- `listPrChecks`, `parseGhPrChecks`, and the `PrCheckInfo` type are removed from `GitHubService`. The per-PR `gh pr checks` call is gone — it was the dominant source of rate-limit pressure.
- The `DetailItem<"check", ...>` variant, `checkIcon`, and `checkColor` helpers are removed. The per-check loop in the tree-builder is removed.
- The `checks: PrCheckInfo[]` field on `PRInfo` is removed.

### Single-call fetch with rollup

- `gh pr list --json` adds `statusCheckRollup` to its requested fields. The list response now contains, per PR, the array of CI check entries that GitHub uses to compute its own status icon.
- One request per repo per refresh cycle, regardless of how many PRs the repo has. This eliminates the N+1 fan-out and is the primary rate-limit fix.
- `parseGhPrList` reduces the rollup array via a new pure function `computeRollup` and stores the result on each `PRInfo`.

### Rollup aggregation rule

`computeRollup(checks: unknown[]): "success" | "failure" | "pending" | null` follows the GitHub web UI's rules:

- Any entry with state `FAILURE`, `TIMED_OUT`, or `STARTUP_FAILURE` → `"failure"`.
- Else any entry with state `IN_PROGRESS`, `QUEUED`, `PENDING`, or `ACTION_REQUIRED` → `"pending"`.
- Else (all entries are `SUCCESS`, `SKIPPED`, `NEUTRAL`, or `CANCELLED`) → `"success"`.
- Empty array → `null` (no icon).

The function is pure, takes `unknown[]` to tolerate `gh`'s heterogeneous shapes (status-style entries with `state`, check-run-style entries with `status`/`conclusion`), and is fully unit-testable from fixtures.

`PRInfo` gains `rollupState: "success" | "failure" | "pending" | null`. The tree row label and the PR picker render an icon based on this value (`✓` / `✗` / `◌` / nothing).

### Refresh model: stale-while-revalidate

- On TUI mount, `useGitHub` reads from the cache synchronously and uses it as the initial state. The tree view renders before any network call.
- A background poll runs every 120 seconds per repo (was 30s). For each repo, if the cached `fetched_at` is younger than 30 seconds at startup, the initial refetch for that repo is skipped (debounce against rapid relaunches).
- A manual refresh keybinding `r` (Navigate mode only) refreshes the focused repo only.
- Opening the OpenModal triggers a background refresh for that one repo (the modal renders from cache; the fetch reconciles when it returns).
- A "Refresh" row pinned at the bottom of the OpenModal's PR picker explicitly triggers a refresh of that repo.
- `AbortController` is wired through the fetch path; it cancels on TUI unmount and on modal `Esc`. Cancelled fetches do not write to the cache (stale cache wins over partial writes).
- Failed fetches do not clear the cache; the previous payload remains visible.

### Per-repo coalescing

- `useGitHub` maintains an `inFlight: Map<project, Promise<PRInfo[]>>`.
- Any trigger (background poll, modal-open refresh, explicit `r`, Refresh row) that finds an entry in the map for that project reuses the existing promise instead of starting a new fetch.
- Multiple simultaneous requests for the same repo collapse to one `gh pr list` invocation.
- When the promise resolves (or is cancelled), the entry is removed from the map.

### Per-repo refreshing & error state

- `isRefreshing(project)` is derived from `inFlight.has(project)`. The same boolean drives the `↻` indicator next to the repo header in the tree view, the `↻ Updating…` indicator in the modal header, and the "↻ Loading..." flip on the modal's Refresh row.
- `lastError(project)` is read from the cache row's `last_error` column. When non-null, a `⚠` is shown next to the repo header and the status bar shows the error string when the cursor is on that repo.
- When `gh` is not installed at all, no error is recorded and no `⚠` is shown — that case is treated as "GitHub integration is not configured", not as a failure.
- When `gh` is installed but the call fails (auth, network, etc.), the error string is written to `last_error` and surfaced.

### Cache shape and storage

- Cache lives in the existing `~/.wct/wct.db` SQLite file alongside the registry.
- New table `pr_cache(project TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, last_error TEXT NULL)` is added as schema migration v2.
- `payload` is a JSON-serialized array of `PRInfo` (number, title, state, headRefName, rollupState). Reads parse it; writes use `INSERT OR REPLACE` of the whole blob — atomic, single statement.
- An empty result is stored as `payload = "[]"` (a valid cached response, distinct from "never fetched").

### Module organization

- A new module `wct-db` is extracted from `registry-service`. It owns the DB path resolution, the append-only `MIGRATIONS` array, the migration runner, and the `schema_version` table mechanics. Both `RegistryService` and the new `PrCacheService` import it; there is one source of truth for the schema.
- A new Effect service `PrCacheService` provides the public surface: `getCached(project)`, `setCached(project, payload)`, `setError(project, error)`, `invalidate(project)`. SQL, JSON serialization, and connection details are encapsulated.
- The TUI runtime layer registers `PrCacheService`. The CLI services layer also registers it (needed for the `projects remove` cleanup path); cost is negligible since the DB connection is opened lazily on first use.

### Cache scope

- The cache serves the TUI only. It is consulted for tree-view PR decoration and the OpenModal PR picker.
- The CLI flow `wct open <pr-number>` (which goes through `resolvePr` → `gh pr view`) does **not** consult or write the cache. CLI behavior is unchanged.
- This keeps `GitHubService` a thin shell over `gh`; `PrCacheService` is strictly a TUI-side optimization layer.

### Cleanup on unregister

- `commands/projects.ts`'s `projectsRemoveCommand` calls `PrCacheService.invalidate(project)` after a successful `RegistryService.unregister`.
- The cleanup is orchestrated at the command layer, not inside `RegistryService`. `RegistryService` stays unaware of caching, matching the existing orchestration-at-call-site pattern.

### Multi-process behavior

- SQLite's built-in write locking covers concurrent writes from multiple `wct tui` instances or from a TUI + CLI invocation.
- Per-process coalescing (the `inFlight` map) does *not* span processes; two TUI instances polling the same repo on overlapping schedules may double-fetch. This is accepted as out-of-scope — the worst case is one extra `gh pr list` per 2-minute window per repo per extra TUI instance.

## Testing Decisions

A good test in this codebase asserts external behavior — observable inputs and outputs — rather than internal structure. Tests do not poke at private state, do not assert on the shape of the SQL or the order of internal calls, and do not depend on which file a function lives in. Each module's tests should survive a structural refactor of that module's internals.

### Modules with tests

**`computeRollup` (pure function, in `github-service.ts`)**
- Empty array → `null`.
- All `SUCCESS` → `"success"`.
- Mix of `SUCCESS` and `SKIPPED`/`NEUTRAL`/`CANCELLED` → `"success"` (skipped/neutral don't downgrade).
- Any `FAILURE` → `"failure"`, regardless of other entries.
- Any `IN_PROGRESS`/`QUEUED`/`PENDING` (with no failure) → `"pending"`.
- `ACTION_REQUIRED` (with no failure) → `"pending"`.
- `TIMED_OUT` and `STARTUP_FAILURE` → `"failure"`.
- Heterogeneous entries (status-style with `state`, check-run-style with `status`/`conclusion`) handled in one input array.
- Unknown future state strings — covered by a "this should not crash" test case; the function tolerates unknown states without throwing.

**`PrCacheService` (against `:memory:` SQLite)**
- `getCached(project)` on an empty DB returns `null`.
- `setCached(project, payload)` followed by `getCached(project)` returns the same payload.
- `invalidate(project)` removes the row; subsequent `getCached` returns `null`.
- `setError(project, "auth expired")` stores the error; a subsequent `getCached` reflects `last_error`; a subsequent `setCached` clears `last_error`.
- Storing an empty array (`[]`) round-trips as `[]`, distinct from `null`.
- Concurrent writes via two services sharing the same DB file do not corrupt each other (SQLite handles this; the test asserts both writes are observable and well-formed).

**`wct-db` migration runner**
- Fresh DB → migrations applied to current `TARGET_SCHEMA_VERSION`; `schema_version` table reflects the final version.
- DB at v1 (legacy registry shape, no `schema_version` row) → v2 applied without losing v1 data.
- Running migrations twice is a no-op; the second invocation does not duplicate rows or fail.
- Each individual migration statement is idempotent against partially-applied state (the existing convention; tests verify the v2 statement specifically).

**`parseGhPrList` (updated)**
- Realistic `gh pr list --json` fixtures including `statusCheckRollup` arrays of various shapes are parsed into `PRInfo[]` with the correct `rollupState`.
- Malformed `statusCheckRollup` (missing field, null, unexpected type) does not throw; the PR is parsed with `rollupState: null`.
- Existing `parseGhPrList` test cases (without `statusCheckRollup`) still pass and produce `rollupState: null`.

**`useGitHub` coalescing**
- Two simultaneous `refresh(project)` calls (started before the first resolves) result in exactly one `gh pr list` invocation. Verified with a fake `GitHubService` that counts calls.
- Cancellation via `AbortController` aborts the in-flight fetch and does not write to the cache.
- A failed fetch leaves the previous cache payload intact and writes `last_error`.
- A successful fetch clears any previously-stored `last_error`.

### Modules without tests

UI rendering for `TreeView`, `RepoNode`, `WorktreeItem`, and `OpenModal` is not unit-tested — these are thin presentation layers over the data the hooks produce, low-bug-density relative to the cost of setting up `ink-testing-library` flows, and easier to verify by running the TUI.

### Prior art

- Existing tests use `vitest` and `@effect/vitest`. Service tests run against in-memory SQLite. The new `PrCacheService` and `wct-db` tests follow the same setup pattern as the existing `RegistryService` tests.
- `parseGhPrList` already has fixture-driven parsing tests; the updated tests extend that file with new fixtures.
- Pure-function tests like `computeRollup` follow the pattern used by other parsers (`parseRemoteOwnerRepo`, `findMatchingRemote`) in `github-service.ts`.

## Out of Scope

- Replacing the `gh` CLI shell-out with direct REST or GraphQL calls (`gh api graphql`, raw HTTP). This is a separate, larger refactor.
- ETag / `If-Modified-Since` conditional requests. `gh` does not surface response headers in its JSON output, so this would require switching off `gh pr list` first.
- Caching `resolvePr` lookups for the CLI `wct open <pr-number>` flow. That command stays exactly as it is today.
- Cross-machine sync of cached data (e.g. via iCloud-synced `~/.wct`). Worktree paths and registry IDs are machine-local; the cache follows the same model.
- Cross-process fetch coalescing. Two `wct tui` instances may issue concurrent `gh pr list` calls for the same repo on overlapping cycles. SQLite's write locking ensures the cache itself remains consistent; the duplicate API call is accepted.
- A hard cache expiry threshold (e.g. "hide PR data older than N days"). The failure-keep-last-known semantics already cover the only realistic case where this would help.
- A separate "refresh all repos" keybinding (e.g. `R`/shift-r). The 2-minute background poll already touches all repos; explicit per-repo `r` covers the user-initiated case.
- Surfacing per-check failure detail anywhere in the UI. Only the rolled-up state remains.
- A loading indicator on the Refresh row itself, beyond the label flip from `↻ Refresh PRs` → `↻ Loading...`.
- A "doctor" / GC sweep to clean orphaned cache rows. Cleanup happens at the moment of unregister; no background sweep is needed.

## Further Notes

- The 2-minute background poll cadence is a starting heuristic. If users find it too slow in practice, it can be tuned without affecting the cache contract or UI; the manual `r` keybinding is the escape hatch.
- Cache invalidation on PR close/merge happens implicitly: a closed PR drops out of `gh pr list`'s next response and the per-repo blob replacement removes it.
- The `↻` indicator doubles as ambient "the data is alive" feedback during background polls — this is intentional, not noise.
- `Esc` cancels in-flight fetches via `AbortController`. Partial responses are not written to the cache.
- The `pr_cache` v2 migration follows the existing convention: idempotent against partially-applied schemas, applied inside the transaction-protected migration runner.
- The `last_error` column captures the most recent failure for a repo. It is cleared on the next successful fetch. This means a transient error self-heals visibly within one refresh cycle.
- When the user re-adds a previously-removed project, the cleanup at unregister time guarantees there is no stale cache for it. The first TUI launch after re-add will fetch fresh.

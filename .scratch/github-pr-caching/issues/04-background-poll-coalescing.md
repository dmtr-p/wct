# Background poll, per-repo coalescing, manual `r`, `↻` indicator

Status: ready-for-agent

## Parent

[PRD: GitHub PR Data Caching & Refresh Refactor](../PRD.md)

## What to build

Change the background refresh cadence from 30s to 120s per repo. Add an `inFlight: Map<project, Promise<PRInfo[]>>` in `useGitHub` so any concurrent trigger (background poll, modal-open refresh, explicit `r`, future Refresh row) for the same project reuses the existing promise instead of starting a new fetch. When the promise resolves or is cancelled, the entry is removed from the map.

Wire `AbortController` through the fetch path so it cancels on TUI unmount. Cancelled fetches do not write to the cache (stale cache wins over partial writes). Add an `r` keybinding (Navigate mode only) that refreshes the focused repo only — not every registered repo. Show a `↻` indicator next to the repo header in the tree view while a fetch for that repo is in flight; the same indicator covers both background polls and explicit `r` refreshes.

`isRefreshing(project)` is derived from `inFlight.has(project)`. This boolean is the single source of truth for the `↻` indicator; later slices (#05, #06) consume the same signal in other UI surfaces.

## Acceptance criteria

- [ ] Background refresh runs every ~120 seconds per repo (story 9)
- [ ] Pressing `r` in Navigate mode triggers a refresh of the focused repo only; other repos are untouched (stories 10, 11)
- [ ] `↻` indicator appears next to the repo header during background polls and during explicit `r` refreshes, with no visual difference between triggers (stories 12, 13)
- [ ] Two simultaneous `refresh(project)` calls collapse to exactly one `gh pr list` invocation (story 24)
- [ ] Unmounting the TUI cancels in-flight fetches via `AbortController`
- [ ] Cancelled fetches do not write to the cache
- [ ] `useGitHub` test: concurrent `refresh(project)` calls result in exactly one `gh pr list` invocation, verified with a fake `GitHubService` that counts calls
- [ ] `useGitHub` test: cancellation via `AbortController` aborts the in-flight fetch and does not write to the cache
- [ ] `useGitHub` test: a failed fetch leaves the previous cache payload intact and writes `last_error`
- [ ] `useGitHub` test: a successful fetch clears any previously-stored `last_error`

## Blocked by

- #03

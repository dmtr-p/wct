# OpenModal stale-while-revalidate + Refresh row + `Esc` cancel

Status: ready-for-agent

## Parent

[PRD: GitHub PR Data Caching & Refresh Refactor](../PRD.md)

## What to build

When the OpenModal opens, render the PR picker from the cache instantly and kick off a background refresh for that one repo (reusing the per-repo coalescing from #04). The picker's PR list keeps showing the last-known PRs while a refresh is in flight — no jumping or blanking.

Add a "Refresh" row pinned at the bottom of the picker. Selecting it triggers an explicit refresh of that repo. While a fetch is in flight, the row's label flips from `↻ Refresh PRs` to `↻ Loading...` and the row becomes non-selectable.

Show a `↻ Updating…` indicator in the modal header while any modal-scoped fetch is in flight — same signal whether the fetch was triggered by the auto-refresh-on-open or by the Refresh row.

Pressing `Esc` while a fetch is in flight cancels the fetch via `AbortController` (no stray `gh` subprocess after the modal closes). Partial responses are not written to the cache.

## Acceptance criteria

- [ ] OpenModal opens instantly, rendering whatever's in the cache for that repo (story 14)
- [ ] A fresh fetch starts automatically when the modal opens (story 15)
- [ ] A "Refresh" row is pinned at the bottom of the PR picker (story 16)
- [ ] During a fetch, the Refresh row label flips to `↻ Loading...` and is non-selectable (story 17)
- [ ] The PR list does not jump or blank while a refresh is in flight (story 18)
- [ ] Pressing `Esc` mid-refresh cancels the in-flight fetch; no stray `gh` subprocess remains (story 19)
- [ ] A `↻ Updating…` indicator appears in the modal header during both auto-refresh-on-open and explicit Refresh row triggers (story 20)

## Blocked by

- #04

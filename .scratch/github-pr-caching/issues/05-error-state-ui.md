# Error state UI (`⚠` + status bar)

Status: ready-for-agent

## Parent

[PRD: GitHub PR Data Caching & Refresh Refactor](../PRD.md)

## What to build

Surface `lastError(project)` (read from the cache row's `last_error` column) in the TUI. When non-null, render a `⚠` next to the repo header in the tree view and, when the cursor is on that repo, render a one-line error string in the status bar. Cached PR data continues to display as last-known-good — the `⚠` is purely additive.

When `gh` is not installed at all, no error is recorded and no `⚠` is shown — that case is treated as "GitHub integration is not configured", not as a failure. When `gh` is installed but the call fails (auth expired, network blip, repo not accessible), the error string is written to `last_error` and surfaced.

The persistence of `last_error` and its clearing on the next successful fetch are already covered in #03; this slice only adds the UI surfacing.

## Acceptance criteria

- [ ] When a fetch fails (e.g. auth expired), `⚠` appears next to the affected repo header (story 22)
- [ ] When the cursor is on a repo with a non-null `last_error`, the status bar shows a one-line error string (story 22)
- [ ] Cached PR data continues to render as last-known-good while `⚠` is shown (story 23)
- [ ] When `gh` is not installed, no `⚠` and no status bar message appear for any repo (story 21)
- [ ] After a successful refresh, the `⚠` for that repo disappears within one cycle (UI follows the cache state already cleared in #03)

## Blocked by

- #03

# Single rollup icon, remove per-check rows

Status: ready-for-agent

## Parent

[PRD: GitHub PR Data Caching & Refresh Refactor](../PRD.md)

## What to build

Replace the per-check rows in the TUI tree view with a single rollup icon next to each PR title. The icon (`✓` / `✗` / `◌` / nothing) matches what github.com shows for the same PR. The dominant source of rate-limit pressure — one `gh pr checks` call per PR — is removed; rollup data comes from a single `gh pr list --json` request per repo per refresh, with `statusCheckRollup` added to the requested fields.

A new pure function `computeRollup(checks: unknown[])` aggregates the rollup array into one of `"success" | "failure" | "pending" | null` using the GitHub web UI's rules:

- Any entry with state `FAILURE`, `TIMED_OUT`, or `STARTUP_FAILURE` → `"failure"`
- Else any entry with state `IN_PROGRESS`, `QUEUED`, `PENDING`, or `ACTION_REQUIRED` → `"pending"`
- Else (all entries are `SUCCESS`, `SKIPPED`, `NEUTRAL`, or `CANCELLED`) → `"success"`
- Empty array → `null` (no icon)

The function takes `unknown[]` to tolerate `gh`'s heterogeneous shapes (status-style entries with `state`, check-run-style entries with `status`/`conclusion`).

`PRInfo` gains `rollupState: "success" | "failure" | "pending" | null`. The `checks: PrCheckInfo[]` field, the `listPrChecks` / `parseGhPrChecks` functions, the `PrCheckInfo` type, the `DetailItem<"check", ...>` variant, and the `checkIcon` / `checkColor` helpers are all removed.

## Acceptance criteria

- [ ] PR rows in the tree view show `✓` / `✗` / `◌` next to the title, or no icon when there are no checks
- [ ] All-success runs that include `SKIPPED` / `NEUTRAL` / `CANCELLED` still render `✓`
- [ ] Any `FAILURE` / `TIMED_OUT` / `STARTUP_FAILURE` renders `✗`
- [ ] Any `IN_PROGRESS` / `QUEUED` / `PENDING` / `ACTION_REQUIRED` (with no failures) renders `◌`
- [ ] No per-check rows render anywhere in the TUI
- [ ] `gh pr checks` is no longer invoked anywhere; rollup data flows from a single `gh pr list --json … statusCheckRollup` per repo per refresh
- [ ] `computeRollup` unit tests cover: empty array; all `SUCCESS`; mix with `SKIPPED`/`NEUTRAL`/`CANCELLED`; any `FAILURE`/`TIMED_OUT`/`STARTUP_FAILURE`; any `PENDING`/`QUEUED`/`IN_PROGRESS`/`ACTION_REQUIRED`; mixed status-style and check-run-style entries; unknown future state strings (does not throw)
- [ ] `parseGhPrList` tests cover: realistic fixtures with `statusCheckRollup` of various shapes; malformed rollup data → `rollupState: null` without throwing; existing fixtures still parse and produce `rollupState: null`

## Blocked by

None - can start immediately

# Cache cleanup on `wct projects remove`

Status: ready-for-agent

## Parent

[PRD: GitHub PR Data Caching & Refresh Refactor](../PRD.md)

## What to build

After `projectsRemoveCommand` calls `RegistryService.unregister` successfully, also call `PrCacheService.invalidate(project)` so the cache stays consistent with the registry. The cleanup is orchestrated at the command layer, not inside `RegistryService` — `RegistryService` stays unaware of caching, matching the existing orchestration-at-call-site pattern.

This guarantees that re-adding a previously-removed project causes the next TUI launch to fetch fresh, rather than displaying ancient cached PRs from the prior registration.

## Acceptance criteria

- [ ] After `wct projects remove <repo>` succeeds, no `pr_cache` row exists for that project (story 26)
- [ ] Re-adding a previously-removed project causes the next TUI launch to fetch fresh — no stale cached PRs from the prior registration (story 27)
- [ ] `RegistryService`'s public API is unchanged; the caching concern remains in the command layer

## Blocked by

- #03

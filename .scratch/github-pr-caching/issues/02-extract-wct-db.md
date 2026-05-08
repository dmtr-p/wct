# Extract `wct-db` migration framework

Status: ready-for-agent

## Parent

[PRD: GitHub PR Data Caching & Refresh Refactor](../PRD.md)

## What to build

Extract DB path resolution, the append-only `MIGRATIONS` array, the migration runner, and the `schema_version` table mechanics out of `RegistryService` into a new shared `wct-db` module. `RegistryService` becomes a consumer of `wct-db` rather than the owner of the schema. This is a pure refactor — no schema changes, no behavior changes.

The motivation is to have a single source of truth for the schema so that adding a v2 (and future versions) does not require updating two services in lockstep.

## Acceptance criteria

- [ ] All existing `RegistryService` tests pass without modification
- [ ] DB path resolution and the `schema_version` table live in `wct-db`, not in `RegistryService`
- [ ] Adding a new migration is a one-line append to a single `MIGRATIONS` array
- [ ] Fresh DB → migrations apply to the current `TARGET_SCHEMA_VERSION`; the `schema_version` table reflects the final version
- [ ] Legacy v1 DB (existing registry shape, no `schema_version` row) → migrations apply without losing v1 data
- [ ] Running migrations twice is a no-op; the second invocation does not duplicate rows or fail
- [ ] Each individual migration statement is idempotent against partially-applied state
- [ ] Migration runner tests cover the four cases above

## Blocked by

None - can start immediately

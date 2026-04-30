# Architecture Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual nested `Effect.provideService` wiring in `src/effect/services.ts` with a proper `Layer.mergeAll` + `Effect.provide` composition, and harden the SQLite registry with transactions and schema versioning.

**Architecture:** Two independent improvements landed sequentially. Phase 1 introduces a single `WctServicesLayer` (`Layer.Layer<WctServices | JsonFlag, never, never>`) built with `Layer.mergeAll(...Layer.succeed(...))`, and rewrites `provideWctServices` to use `Effect.provide` against that layer. Phase 2 adds a `schema_version` table, a sequential migration runner, and wraps multi-step operations in `db.transaction(...)` while keeping the existing per-call open/close lifecycle (no service-wide handle changes). The public `RegistryServiceApi` and `WctServices` types are unchanged.

**Tech Stack:** Bun, `bun:sqlite`, Effect v4 (`effect@4.0.0-beta.59`), `@effect/platform-bun@4.0.0-beta.59`, `@effect/vitest@4.0.0-beta.59`, vitest 4.1.0.

---

## File Structure

- Modify: `/Users/dmtr/code/wct/src/effect/services.ts`
  - Export `WctServicesLayer` built via `Layer.mergeAll`.
  - Rewrite `provideWctServices` as `Effect.provide(effect, WctServicesLayer)`.
- Modify: `/Users/dmtr/code/wct/tests/helpers/effect-vitest.ts`
  - Import `WctServicesLayer` and simplify `WctTestLayer` to `Layer.mergeAll(WctServicesLayer, BunServices.layer)`.
- Modify: `/Users/dmtr/code/wct/src/services/registry-service.ts`
  - Delete `REGISTRY_SCHEMA_SQL` (superseded by v1 migration entry).
  - Add `MIGRATIONS` array, `schema_version` table, and `runMigrations` helper.
  - Wrap `register`'s SELECT-then-INSERT/UPDATE in `db.transaction(...)`.
- Add: `/Users/dmtr/code/wct/tests/effect/services.test.ts`
  - Verify `WctServicesLayer` provides every wct service and `JsonFlag`.
- Modify: `/Users/dmtr/code/wct/tests/services/registry-service.test.ts`
  - Add tests for schema version tracking, migration application, idempotent re-open, and transaction atomicity on `register`.

## Repo Constraints

- Per `CLAUDE.md`: **do not run tests, lint, or format manually**. Hooks handle this:
  - PostToolUse runs `biome format --write` on every edit.
  - Stop hook runs `biome lint --write` and `bun run test`; exit code 2 wakes the agent on failure.
- Each task ends with a `git commit`; the Stop hook validates correctness on the way out of the session.
- The "Run test" step in each task below means: save edits, let the Stop hook run, and read what it reports — do not invoke `bun run test` directly.
- No new runtime dependencies. The registry continues to use `bun:sqlite` (no migrations library).

---

## Phase 1 — Layer-based service wiring

### Task 1: Add a failing test that asserts `WctServicesLayer` is exported and provides every service

**Files:**
- Add: `/Users/dmtr/code/wct/tests/effect/services.test.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/dmtr/code/wct/tests/effect/services.test.ts` with:

```ts
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { JsonFlag } from "../../src/cli/json-flag";
import { WctServicesLayer } from "../../src/effect/services";
import { GitHubService } from "../../src/services/github-service";
import { IdeService } from "../../src/services/ide-service";
import { RegistryService } from "../../src/services/registry-service";
import { SetupService } from "../../src/services/setup-service";
import { TmuxService } from "../../src/services/tmux";
import { VSCodeWorkspaceService } from "../../src/services/vscode-workspace";
import { WorktreeService } from "../../src/services/worktree-service";
import { BunServices } from "@effect/platform-bun";

describe("WctServicesLayer", () => {
  // BunServices is required because some live services call execProcess
  // through the Bun platform layer; mirror the runtime composition.
  it.layer(Layer.mergeAll(WctServicesLayer, BunServices.layer))(
    "exposes every wct service plus JsonFlag",
    (it) => {
      it.effect("resolves every service tag without missing-context errors", () =>
        Effect.gen(function* () {
          const github = yield* GitHubService;
          const ide = yield* IdeService;
          const registry = yield* RegistryService;
          const setup = yield* SetupService;
          const tmux = yield* TmuxService;
          const vscode = yield* VSCodeWorkspaceService;
          const worktree = yield* WorktreeService;
          const json = yield* JsonFlag;

          expect(typeof github.isGhInstalled).toBe("function");
          expect(typeof ide.openIDE).toBe("function");
          expect(typeof registry.listRepos).toBe("function");
          expect(typeof setup.runSetupCommands).toBe("function");
          expect(typeof tmux.sessionExists).toBe("function");
          expect(typeof vscode.syncWorkspaceState).toBe("function");
          expect(typeof worktree.isGitRepo).toBe("function");
          expect(json).toBe(false);
        }),
      );
    },
  );
});
```

Method names are verified against the live interfaces — use them as written.

- [ ] **Step 2: Run test to verify it fails**

Save the file and let the Stop hook run.

Expected: FAIL with a TypeScript compile error such as `Module '"../../src/effect/services"' has no exported member 'WctServicesLayer'`.

- [ ] **Step 3: Implement — export `WctServicesLayer`**

Edit `/Users/dmtr/code/wct/src/effect/services.ts`. Make these three targeted changes:

1. Add `Layer` to the `effect` import: `import { Effect, Layer } from "effect";`
2. Insert the exported `WctServicesLayer` constant before `provideWctServices`
3. Rewrite the body of `provideWctServices` to `return Effect.provide(effect, WctServicesLayer) as ...`

The full resulting file should look like:

```ts
import type { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { JsonFlag } from "../cli/json-flag";
import {
  GitHubService,
  type GitHubService as GitHubServiceApi,
  liveGitHubService,
} from "../services/github-service";
import {
  IdeService,
  type IdeService as IdeServiceApi,
  liveIdeService,
} from "../services/ide-service";
import {
  liveRegistryService,
  RegistryService,
  type RegistryServiceApi,
} from "../services/registry-service";
import {
  liveSetupService,
  SetupService,
  type SetupService as SetupServiceApi,
} from "../services/setup-service";
import {
  liveTmuxService,
  TmuxService,
  type TmuxService as TmuxServiceApi,
} from "../services/tmux";
import {
  liveVSCodeWorkspaceService,
  VSCodeWorkspaceService,
  type VSCodeWorkspaceService as VSCodeWorkspaceServiceApi,
} from "../services/vscode-workspace";
import {
  liveWorktreeService,
  WorktreeService,
  type WorktreeService as WorktreeServiceApi,
} from "../services/worktree-service";

export type WctServices =
  | BunServices.BunServices
  | GitHubServiceApi
  | IdeServiceApi
  | RegistryServiceApi
  | SetupServiceApi
  | TmuxServiceApi
  | VSCodeWorkspaceServiceApi
  | WorktreeServiceApi;

export type WctRuntimeServices =
  | BunServices.BunServices
  | GitHubServiceApi
  | RegistryServiceApi
  | TmuxServiceApi
  | WorktreeServiceApi;

/**
 * Layer providing every live wct service plus the default `JsonFlag` value.
 * Does NOT include `BunServices.layer`; that is provided separately by
 * `provideBunServices` in `runtime.ts` so live tests can compose them
 * independently. The `ROut` is the union of every wct service tag plus
 * `JsonFlag`.
 */
export const WctServicesLayer = Layer.mergeAll(
  Layer.succeed(GitHubService, liveGitHubService),
  Layer.succeed(IdeService, liveIdeService),
  Layer.succeed(SetupService, liveSetupService),
  Layer.succeed(TmuxService, liveTmuxService),
  Layer.succeed(VSCodeWorkspaceService, liveVSCodeWorkspaceService),
  Layer.succeed(WorktreeService, liveWorktreeService),
  Layer.succeed(RegistryService, liveRegistryService),
  Layer.succeed(JsonFlag, false),
);

export function provideWctServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E,
  Exclude<R, WctServices | "effect/unstable/cli/GlobalFlag/json">
> {
  return Effect.provide(effect, WctServicesLayer) as Effect.Effect<
    A,
    E,
    Exclude<R, WctServices | "effect/unstable/cli/GlobalFlag/json">
  >;
}
```

Key shape decisions:

- `WctServicesLayer` is exported so tests and future call sites can pull the dependency graph as a first-class value.
- `provideWctServices` keeps the same signature so every existing caller (`src/index.ts`) compiles unchanged.
- `BunServices.layer` is intentionally NOT merged in — it is provided separately by `provideBunServices` in `runtime.ts`. Merging it here would change the call shape in `src/index.ts` (`provideBunServices(provideWctServices(...))` would become a no-op).
- **Risk — `Layer.succeed(JsonFlag, false)`:** `JsonFlag` is a `GlobalFlag.setting(...)` from the unstable CLI module. The existing `Effect.provideService(JsonFlag, false)` works, so the context tag mechanism is compatible; `Layer.succeed` uses the same mechanism. If the test in Step 1 fails with a missing-context or type error on `JsonFlag`, fall back to `Layer.succeedContext(Context.make(JsonFlag, false))` or check whether `GlobalFlag.setting` exposes a `.layer(false)` constructor.

- [ ] **Step 4: Run test to verify it passes**

Save and let the Stop hook run.

Expected: PASS for every assertion in `tests/effect/services.test.ts`. Existing tests remain green because the public `provideWctServices` signature is unchanged.

- [ ] **Step 4b: Refactor `WctTestLayer` to compose from `WctServicesLayer`**

Edit `/Users/dmtr/code/wct/tests/helpers/effect-vitest.ts`:

1. Add `WctServicesLayer` to the import from `../../src/effect/services`:
   ```ts
   import { WctServicesLayer, ... } from "../../src/effect/services";
   ```
2. Replace the 9-line `Layer.mergeAll(Layer.succeed(...), ..., BunServices.layer)` block for `WctTestLayer` with:
   ```ts
   export const WctTestLayer = Layer.mergeAll(WctServicesLayer, BunServices.layer);
   ```
   The individual `Layer.succeed(...)` lines are no longer needed for `WctTestLayer`; leave the individual service imports in place because `wctTestLayer(overrides)` still references them for per-test override composition.

- [ ] **Step 4c: Run tests to verify nothing regressed**

Save and let the Stop hook run.

Expected: PASS for all existing tests — `WctTestLayer` is semantically identical, just composed from the exported layer rather than re-declaring it inline.

- [ ] **Step 5: Commit**

```bash
git add src/effect/services.ts tests/effect/services.test.ts tests/helpers/effect-vitest.ts
git commit -m "$(cat <<'EOF'
refactor(effect): expose WctServicesLayer and use Effect.provide for service wiring

Replace nested Effect.provideService calls in provideWctServices with a single
Layer.mergeAll-built layer. Makes the dependency graph explicit and gives tests
and future composition a first-class Layer value to merge or override.
WctTestLayer now composes from WctServicesLayer to eliminate duplication.

EOF
)"
```

---

## Phase 2 — Registry transactions and schema versioning

### Task 2: Add a failing test for the `schema_version` table

**Files:**
- Modify: `/Users/dmtr/code/wct/tests/services/registry-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new test inside the existing `it.layer(WctTestLayer)("operates against $HOME registry", ...)` block in `/Users/dmtr/code/wct/tests/services/registry-service.test.ts`. Also add `import { Database } from "bun:sqlite"` to the top-level imports if not already present.

> **Coupling note:** The tests below open the DB directly using `` `${process.env.HOME}/.wct/wct.db` ``. This works because the test suite's `beforeEach` redirects `HOME` to a temp directory. If `getWctDir()` or `getDbPath()` in the registry implementation ever change their path logic, these direct-open calls will silently target the wrong file. This is an accepted trade-off — keep both sides in sync if the path changes.

```ts
    it.effect("creates schema_version table with current version on first open", () =>
      Effect.gen(function* () {
        const registry = yield* RegistryService;
        // Trigger DB open by performing any operation.
        yield* registry.listRepos();

        const db = new Database(`${process.env.HOME}/.wct/wct.db`, {
          readonly: true,
        });
        try {
          const row = db
            .query(
              "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
            )
            .get() as { version: number } | null;
          expect(row).not.toBeNull();
          expect(row?.version).toBe(1);
        } finally {
          db.close();
        }
      }),
    );
```

- [ ] **Step 2: Run test to verify it fails**

Save and let the Stop hook run.

Expected: FAIL with `SQLiteError: no such table: schema_version` thrown from inside the test body.

- [ ] **Step 3: Implement migrations runner**

Edit `/Users/dmtr/code/wct/src/services/registry-service.ts`. **Delete** the `REGISTRY_SCHEMA_SQL` constant entirely (its table definition is superseded by the v1 migration entry) and replace the `withDb` helper with:

```ts
const SCHEMA_VERSION_SQL = `CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`;

/**
 * Idempotent migrations applied in order on every DB open. The index in
 * this array IS the target version — DO NOT reorder, only append.
 * Each statement must be safe to run against a partially-migrated DB,
 * because we apply migrations one-by-one inside a transaction.
 */
const MIGRATIONS: readonly string[] = [
  // v1 — initial registry schema. Matches the legacy CREATE TABLE IF NOT
  // EXISTS shape so DBs that pre-date schema_version (and therefore are
  // recorded as v0) re-converge cleanly without a destructive migration.
  `CREATE TABLE IF NOT EXISTS registry (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL UNIQUE,
    project TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

const TARGET_SCHEMA_VERSION = MIGRATIONS.length;

function getCurrentSchemaVersion(db: Database): number {
  const row = db
    .query("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | null;
  return row?.version ?? 0;
}

function runMigrations(db: Database): void {
  db.run(SCHEMA_VERSION_SQL);
  const current = getCurrentSchemaVersion(db);
  if (current >= TARGET_SCHEMA_VERSION) return;

  const apply = db.transaction(() => {
    for (let v = current; v < TARGET_SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v];
      if (!sql) continue;
      db.run(sql);
      db.run(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
        [v + 1, Date.now()],
      );
    }
  });
  apply();
}

function withDb<A>(
  operation: string,
  f: (db: Database) => A,
): Effect.Effect<A, WctError> {
  return Effect.try({
    try: () => {
      mkdirSync(getWctDir(), { recursive: true });
      const db = new Database(getDbPath(), { create: true });
      db.run("PRAGMA journal_mode=WAL");
      runMigrations(db);
      try {
        return f(db);
      } finally {
        db.close();
      }
    },
    catch: (error) =>
      commandError(
        "registry_error",
        `Registry database operation failed during ${operation}`,
        error,
      ),
  });
}
```

Notes:

- `db.transaction(() => { ... })` is the `bun:sqlite` API — it returns a callable that wraps the closure in `BEGIN`/`COMMIT`, rolling back on throw.
- The `MIGRATIONS` array is append-only. Adding a v2 means pushing a new SQL string and bumping nothing else; `TARGET_SCHEMA_VERSION` derives from `.length`.
- v0 → v1 is a `CREATE TABLE IF NOT EXISTS` so legacy DBs (created before this change) survive: the table already exists, the migration is a no-op, and `schema_version` records v1.

- [ ] **Step 4: Also add the idempotence guard test**

In the same `it.layer(WctTestLayer)` block, append a second test (no new Step needed — this is part of the same task):

```ts
    it.effect("does not re-apply migrations on subsequent opens", () =>
      Effect.gen(function* () {
        const registry = yield* RegistryService;
        // First open runs migrations.
        yield* registry.listRepos();
        // Second open — guard should short-circuit.
        yield* registry.listRepos();

        const db = new Database(`${process.env.HOME}/.wct/wct.db`, {
          readonly: true,
        });
        try {
          const rows = db
            .query("SELECT version FROM schema_version ORDER BY version ASC")
            .all() as { version: number }[];
          // Exactly one row per migration version — no duplicates.
          expect(rows.map((r) => r.version)).toEqual([1]);
        } finally {
          db.close();
        }
      }),
    );
```

- [ ] **Step 5: Run tests to verify both pass**

Save and let the Stop hook run.

Expected: PASS for both new tests; existing registry tests still green. If the idempotence test fails, the `if (current >= TARGET_SCHEMA_VERSION) return;` guard in `runMigrations` is the likely culprit — ensure it runs after `db.run(SCHEMA_VERSION_SQL)` so the table exists before querying.

- [ ] **Step 6: Expand the `MIGRATIONS` doc comment to spell out the append-only contract**

In `src/services/registry-service.ts`, replace the brief comment above `MIGRATIONS` with:

```ts
/**
 * Append-only migrations table. Index N (0-based) is the SQL applied to
 * advance from version N to version N+1.
 *
 * Rules:
 *  - Never edit, reorder, or delete an entry — that breaks DBs already at
 *    that version.
 *  - Always append. To add v2, push exactly one new SQL string.
 *  - Each statement must be idempotent against a partially-applied schema
 *    (use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` only
 *    after a presence check via PRAGMA, etc.) so legacy DBs that pre-date
 *    schema_version converge cleanly on first open.
 *  - The migration runner records `(version, applied_at)` in
 *    `schema_version` after each statement succeeds; the whole upgrade
 *    runs inside a single sqlite transaction, so a mid-upgrade crash
 *    rolls back to the previous version.
 *
 * `TARGET_SCHEMA_VERSION` is derived from this array's length — do not
 * hand-edit it.
 */
```

- [ ] **Step 7: Commit**

```bash
git add src/services/registry-service.ts tests/services/registry-service.test.ts
git commit -m "$(cat <<'EOF'
feat(registry): track schema version and run migrations on db open

Add a schema_version table and a sequential migrations runner so the registry
schema can evolve safely. Legacy databases (created before this change) skip
the v0 to v1 migration cleanly because the v1 SQL is CREATE TABLE IF NOT EXISTS.
Guard short-circuits on re-open so migrations are never applied twice.

EOF
)"
```

---

### Task 3: Wrap `register` in a transaction and add regression guard

**Files:**
- Modify: `/Users/dmtr/code/wct/tests/services/registry-service.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the same `it.layer(WctTestLayer)` block. The goal is to prove that `register` runs inside a transaction — the cleanest way is to verify the implementation calls `db.transaction(...)` by spying on Bun's `Database`. `bun:sqlite` exposes a `transaction` instance method, so we test the behavior end-to-end: insert + read-back are consistent under a UNIQUE-constraint conflict.

```ts
    it.effect("register transaction wrap preserves idempotent upsert behavior", () =>
      Effect.gen(function* () {
        const registry = yield* RegistryService;

        yield* registry.register("/tmp/tx-repo", "alpha");
        yield* registry.register("/tmp/tx-repo", "beta");

        const repos = yield* registry.listRepos();
        const matches = repos.filter((r) => r.repo_path === "/tmp/tx-repo");
        expect(matches.length).toBe(1);
        expect(matches[0]?.project).toBe("beta");
      }),
    );
```

This is a regression guard: it will PASS against the current implementation and must continue to pass after the transaction is added. True concurrent-write atomicity cannot be proven from a single-process test — the transaction is added for correctness under concurrent `wct` invocations, not because this test would catch its absence.

- [ ] **Step 2: Run test to verify it currently passes**

Save and let the Stop hook run.

Expected: PASS — the existing implementation already updates rather than inserts on conflict.

- [ ] **Step 3: Wrap `register` in a transaction**

Edit `/Users/dmtr/code/wct/src/services/registry-service.ts`. In `liveRegistryService`, change the `register` implementation to wrap the SELECT-then-INSERT/UPDATE block in `db.transaction(...)`:

```ts
  register: (repoPath, project) =>
    withDb("register repo", (db) => {
      const tx = db.transaction(() => {
        const existing = db
          .query("SELECT * FROM registry WHERE repo_path = ?")
          .get(repoPath) as RegistryItem | null;

        if (existing) {
          if (existing.project !== project) {
            db.run("UPDATE registry SET project = ? WHERE repo_path = ?", [
              project,
              repoPath,
            ]);
          }
          return { ...existing, project };
        }

        const id = generateId();
        const created_at = Date.now();
        const item: RegistryItem = {
          id,
          repo_path: repoPath,
          project,
          created_at,
        };
        db.run(
          "INSERT INTO registry (id, repo_path, project, created_at) VALUES (?, ?, ?, ?)",
          [id, repoPath, project, created_at],
        );
        return item;
      });
      return tx();
    }),
```

`unregister`, `listRepos`, and `findByPath` are single-statement and do not need an explicit transaction (`bun:sqlite` already runs each statement atomically). Leave them unchanged.

- [ ] **Step 4: Run test to verify it still passes**

Save and let the Stop hook run.

Expected: PASS — the user-visible behavior is identical, the new wrapping just makes it atomic under concurrency.

- [ ] **Step 5: Commit**

```bash
git add src/services/registry-service.ts tests/services/registry-service.test.ts
git commit -m "$(cat <<'EOF'
feat(registry): wrap register in a sqlite transaction

The SELECT-then-INSERT/UPDATE path in register is now atomic. A regression
guard test verifies idempotent upsert behavior; true concurrent-write
atomicity is ensured by the sqlite transaction but not exercised in the
test suite (would require concurrent processes).

EOF
)"
```

---

## Verification Checklist (run after final task)

- [ ] `git log --oneline` shows 3 commits in this order: services layer, registry migrations + idempotence guard + MIGRATIONS doc, register transaction.
- [ ] `git diff main -- src/effect/services.ts` shows nested `provideService` calls replaced by `Layer.mergeAll` + `Effect.provide`.
- [ ] `git diff main -- src/services/registry-service.ts` shows `schema_version` table, `MIGRATIONS` array, `runMigrations` helper, and `db.transaction(...)` wrap in `register`.
- [ ] Stop hook reports `bun run test` passing for the new `tests/effect/services.test.ts` block and the four new `tests/services/registry-service.test.ts` cases.
- [ ] `src/index.ts` was NOT touched — `provideWctServices` keeps its public signature.
- [ ] `RegistryServiceApi` was NOT changed — every call site (commands, TUI hooks) keeps compiling unchanged.

# @effect/vitest Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@effect/vitest@4.0.0-beta.59` as a devDependency and establish the canonical pattern for Effect-aware tests, without rewriting the existing 554 test blocks.

**Architecture:** Bring in the package, amend the dev-dep allowlist in `CLAUDE.md`, build a `Layer.Layer<WctServices>` test helper that mirrors `withTestServices` overrides for use with `it.layer`, and migrate one small Effect-heavy test file (`tests/services/registry-service.test.ts`) as the canonical example. Existing `runBunPromise` + `withTestServices` callers continue to work — migration of other files is opportunistic, not mandated.

**Tech Stack:** Bun, Effect v4 (`effect@4.0.0-beta.59`), `@effect/platform-bun@4.0.0-beta.59`, vitest 4.1.0, `@effect/vitest@4.0.0-beta.59`.

---

## File Structure

- Modify: `package.json`
  - Add `@effect/vitest@4.0.0-beta.59` to `devDependencies`.
- Modify: `CLAUDE.md`
  - Extend the dev-dep allowlist line to include `@effect/vitest`.
- Create: `tests/helpers/effect-vitest.ts`
  - Export `WctTestLayer` — a layer containing every live wct service plus `JsonFlag=false` **merged with `BunServices.layer`**, so live services that call `execProcess` / `ChildProcess` work the same way they do under `runBunPromise(withTestServices(...))`. The `ROut` of this layer is `WctServices | typeof JsonFlag.Identifier` — i.e. `JsonFlag` is provided alongside, not part of, `WctServices`. Let TS infer the type; do not annotate as `Layer.Layer<WctServices>`. Suitable for `it.layer(WctTestLayer)`.
  - Export `wctTestLayer(overrides)` — variant that takes a `ServiceOverrides` **imported from the existing `tests/helpers/services.ts`** (single source of truth — adding a new override there propagates here automatically). Returns a layer with the override applied. Also merges in `BunServices.layer`.
  - Re-export `ServiceOverrides` type for ergonomic imports from this helper.
- Modify: `tests/services/registry-service.test.ts`
  - Convert to use `it.effect` + `RegistryService` access via `yield*`, dropping the dynamic `import()` indirection.
- Modify: `EFFECT_V4.md`
  - Add a short "Testing with @effect/vitest" subsection documenting when to reach for `it.effect` / `it.layer` versus the existing `runBunPromise` + `withTestServices` pattern.

## Repo Constraints

- Per `CLAUDE.md`: **do not run tests, lint, or format manually**. Hooks handle this:
  - PostToolUse runs `biome format --write` on every edit.
  - Stop hook runs `biome lint --write` and `bun run test`, exit code 2 wakes the agent on failure.
- Each task ends with a `git commit`; the Stop hook validates correctness on the way out of the session.
- The verification step in each task below is **read what the hook reports**, not run the test directly.
- No new runtime dependencies are added by this plan.

## Coexistence Policy

This plan does **not** delete `tests/helpers/services.ts` or change any callers of `runBunPromise` / `withTestServices`. Both patterns coexist:

- **Old pattern** (`runBunPromise(withTestServices(...))`) — keep using for tests that already work and for tests that need fine-grained `Effect.runPromise` control or `vi.spyOn` style mocks combined with imperative setup/teardown.
- **New pattern** (`it.effect` + `it.layer(WctTestLayer)`) — preferred for new Effect-aware tests and for opportunistic migration when editing an existing file.

---

### Task 1: Add @effect/vitest to devDependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the dependency via `bun add`**

Run:

```bash
bun add -d @effect/vitest@4.0.0-beta.59
```

This updates `package.json` and the lockfile in one step and preserves bun's canonical key ordering, avoiding hand-edit churn.

Expected: `package.json` `devDependencies` now contains `"@effect/vitest": "4.0.0-beta.59"` and the lockfile updates.

- [ ] **Step 2: Smoke-check the import resolves**

Run:

```bash
bun -e 'import("@effect/vitest").then(m => console.log(typeof m.it, typeof m.layer))'
```

Expected output: `function function`. If the import rejects, read the rejection reason — peer-dep resolution against the local `vitest` install is the typical failure point; `bun pm ls @effect/vitest vitest` shows the resolved versions.

- [ ] **Step 3: Commit**

```bash
git status --porcelain
git add package.json bun.lock bun.lockb 2>/dev/null || true
git commit -m "chore: add @effect/vitest@4.0.0-beta.59 devDependency"
```

The `bun.lock`/`bun.lockb` glob handles either lockfile name. Verify with `git status --porcelain` first that exactly the package files are staged before committing.

---

### Task 2: Update CLAUDE.md dev-dep allowlist

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Locate the allowlist sentence**

Find this exact text in `CLAUDE.md` (currently in the "Bun Runtime" section, around the paragraph discussing runtime dependencies):

```
The only dev dependency exceptions are `@biomejs/biome`, `@types/bun`, and `vitest`.
```

- [ ] **Step 2: Replace with the updated allowlist**

Replace the sentence above with:

```
The only dev dependency exceptions are `@biomejs/biome`, `@types/bun`, `vitest`, and `@effect/vitest`.
```

Do not change any other text in the paragraph.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: allow @effect/vitest in dev dep allowlist"
```

---

### Task 3: Create the WctTestLayer helper

**Files:**
- Create: `tests/helpers/effect-vitest.ts`

- [ ] **Step 1: Write the helper**

Create `tests/helpers/effect-vitest.ts` with this exact content:

```ts
import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { JsonFlag } from "../../src/cli/json-flag";
import { GitHubService, liveGitHubService } from "../../src/services/github-service";
import { IdeService, liveIdeService } from "../../src/services/ide-service";
import {
  liveRegistryService,
  RegistryService,
} from "../../src/services/registry-service";
import {
  liveSetupService,
  SetupService,
} from "../../src/services/setup-service";
import { liveTmuxService, TmuxService } from "../../src/services/tmux";
import {
  liveVSCodeWorkspaceService,
  VSCodeWorkspaceService,
} from "../../src/services/vscode-workspace";
import {
  liveWorktreeService,
  WorktreeService,
} from "../../src/services/worktree-service";
import type { ServiceOverrides } from "./services";

export type { ServiceOverrides };

/**
 * Layer providing every wct live service, JsonFlag=false, and BunServices.
 * BunServices is required because live services (worktree, tmux, github)
 * call execProcess / ChildProcess, which are provided by the Bun platform.
 * This mirrors the runtime composition of `runBunPromise(withTestServices(...))`.
 *
 * Use with `it.layer(WctTestLayer)((it) => { it.effect(...) })` from
 * @effect/vitest.
 */
export const WctTestLayer = Layer.mergeAll(
  Layer.succeed(GitHubService, liveGitHubService),
  Layer.succeed(IdeService, liveIdeService),
  Layer.succeed(SetupService, liveSetupService),
  Layer.succeed(TmuxService, liveTmuxService),
  Layer.succeed(VSCodeWorkspaceService, liveVSCodeWorkspaceService),
  Layer.succeed(WorktreeService, liveWorktreeService),
  Layer.succeed(RegistryService, liveRegistryService),
  Layer.succeed(JsonFlag, false),
  BunServices.layer,
);

/**
 * Variant of `WctTestLayer` that swaps in per-test overrides matching
 * the same shape as `withTestServices` from `./services.ts`. Use when a
 * single test or describe block needs a fake implementation. Also merges
 * in `BunServices.layer` so live fallthroughs that call execProcess work.
 */
export function wctTestLayer(overrides: ServiceOverrides = {}) {
  return Layer.mergeAll(
    Layer.succeed(GitHubService, overrides.github ?? liveGitHubService),
    Layer.succeed(IdeService, overrides.ide ?? liveIdeService),
    Layer.succeed(SetupService, overrides.setup ?? liveSetupService),
    Layer.succeed(TmuxService, overrides.tmux ?? liveTmuxService),
    Layer.succeed(
      VSCodeWorkspaceService,
      overrides.vscodeWorkspace ?? liveVSCodeWorkspaceService,
    ),
    Layer.succeed(WorktreeService, overrides.worktree ?? liveWorktreeService),
    Layer.succeed(RegistryService, overrides.registry ?? liveRegistryService),
    Layer.succeed(JsonFlag, overrides.json ?? false),
    BunServices.layer,
  );
}

// Compile-time exhaustiveness check: every key of `ServiceOverrides` must
// appear in the `_HandledOverrideKeys` union below. If a new optional key is
// added to `ServiceOverrides` in `./services.ts` and not handled by
// `wctTestLayer`, this assignment fails to compile, forcing the helper to be
// updated alongside. Keep the union literal in sync with the keys handled
// in `wctTestLayer` above.
type _HandledOverrideKeys =
  | "github"
  | "ide"
  | "json"
  | "registry"
  | "setup"
  | "tmux"
  | "vscodeWorkspace"
  | "worktree";
type _AssertOverridesExhaustive =
  keyof ServiceOverrides extends _HandledOverrideKeys
    ? _HandledOverrideKeys extends keyof ServiceOverrides
      ? true
      : never
    : never;
const _exhaustive: _AssertOverridesExhaustive = true;
void _exhaustive;
```

- [ ] **Step 2: Add a sanity test for the helper**

Create `tests/helpers/effect-vitest.test.ts` with this content. The `WorktreeService.isGitRepo` call is deliberate — it goes through `execProcess`, which only resolves when `BunServices.layer` is wired in. If the merge is wrong, this test fails with a missing-platform-service error. The assertion runs in a non-git temp dir so the value (`false`) is meaningful, not just a typeof tautology.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, beforeAll, expect } from "vitest";
import { JsonFlag } from "../../src/cli/json-flag";
import { WorktreeService } from "../../src/services/worktree-service";
import { wctTestLayer, WctTestLayer } from "./effect-vitest";

describe("WctTestLayer", () => {
  let nonGitDir: string;

  beforeAll(() => {
    nonGitDir = mkdtempSync(join(tmpdir(), "wct-test-layer-non-git-"));
  });

  afterAll(() => {
    rmSync(nonGitDir, { recursive: true, force: true });
  });

  it.layer(WctTestLayer)("provides every wct service", (it) => {
    it.effect("WorktreeService.isGitRepo returns false in non-git dir", () =>
      Effect.gen(function* () {
        const wt = yield* WorktreeService;
        // Calls into execProcess(`git rev-parse ...`); requires BunServices.
        // Asserting the negative case rules out both wiring and behavior.
        const result = yield* wt.isGitRepo(nonGitDir);
        expect(result).toBe(false);
      }),
    );

    it.effect("JsonFlag defaults to false", () =>
      Effect.gen(function* () {
        const json = yield* JsonFlag;
        expect(json).toBe(false);
      }),
    );
  });

  it.layer(wctTestLayer({ json: true }))(
    "wctTestLayer applies overrides",
    (it) => {
      it.effect("JsonFlag honors override", () =>
        Effect.gen(function* () {
          const json = yield* JsonFlag;
          expect(json).toBe(true);
        }),
      );
    },
  );
});
```

> **Note:** verify the actual signature of `WorktreeService.isGitRepo` in `src/services/worktree-service.ts` — it currently takes `(cwd?: string)`. If the source has changed by the time you implement this, substitute any method that takes a path and calls `execProcess`; the goal is to exercise the platform layer through a deterministic, non-tautological assertion.

- [ ] **Step 3: Stop the session so the hook runs lint + tests**

Per repo policy, do not run `bun run test` directly. End the working session and let the Stop hook execute `biome lint --write` and `bun run test`. The hook surfaces failures (exit code 2) that wake the agent. Investigate any failure before proceeding.

Common failure modes to watch for:
- `JsonFlag` import path mismatch (it's `src/cli/json-flag.ts`, lowercase).
- `Layer.succeed(Tag, value)` argument order — `Tag` first, value second in Effect v4.
- `it.layer(...)` callback signature is `(it) => void`; if TypeScript complains the inner `it` is unused, that means the layer wasn't applied.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/effect-vitest.ts tests/helpers/effect-vitest.test.ts
git commit -m "test: add WctTestLayer helper for @effect/vitest"
```

---

### Task 4: Migrate registry-service.test.ts as the canonical example

**Files:**
- Modify: `tests/services/registry-service.test.ts`

This task replaces the dynamic `await import()` plus `Effect.runPromise(...)` pattern with `it.effect` and direct service access via `yield*`. The behavior assertions stay identical.

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `tests/services/registry-service.test.ts` with:

```ts
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach, expect } from "vitest";
import { RegistryService } from "../../src/services/registry-service";
import { WctTestLayer } from "../helpers/effect-vitest";

describe("registry-service", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `wct-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.layer(WctTestLayer)("operates against $HOME registry", (it) => {
    it.effect("register and list repos", () =>
      Effect.gen(function* () {
        const registry = yield* RegistryService;

        const item = yield* registry.register(
          "/tmp/fake-repo",
          "test-project",
        );
        expect(item.repo_path).toBe("/tmp/fake-repo");
        expect(item.project).toBe("test-project");

        const repos = yield* registry.listRepos();
        expect(repos.length).toBeGreaterThanOrEqual(1);
        expect(
          repos.find((r) => r.repo_path === "/tmp/fake-repo"),
        ).toBeDefined();

        const removed = yield* registry.unregister("/tmp/fake-repo");
        expect(removed).toBe(true);
      }),
    );

    it.effect("register is idempotent and updates project name", () =>
      Effect.gen(function* () {
        const registry = yield* RegistryService;

        yield* registry.register("/tmp/idem-repo", "old-name");
        const updated = yield* registry.register("/tmp/idem-repo", "new-name");
        expect(updated.project).toBe("new-name");

        yield* registry.unregister("/tmp/idem-repo");
      }),
    );

    it.effect("unregister returns false for unknown path", () =>
      Effect.gen(function* () {
        const registry = yield* RegistryService;

        const removed = yield* registry.unregister("/tmp/does-not-exist");
        expect(removed).toBe(false);
      }),
    );
  });
});
```

Key differences from the previous version, for the reviewer:

1. `import { describe, it } from "@effect/vitest"` replaces the test runner imports. `expect`, `beforeEach`, `afterEach` still come from `vitest`.
2. Dynamic `await import()` indirection is removed — `RegistryService` is imported statically.
3. `Effect.runPromise(liveRegistryService.method(...))` becomes `yield* registry.method(...)` inside `Effect.gen`.
4. The `it.layer(WctTestLayer)(...)` block applies `WctTestLayer` to every test inside it. The layer is built once for the block and reused across the inner `it.effect` cases (this matches `@effect/vitest@4.0.0-beta.59` behavior — re-verify against the installed version's source if behavior changes).
5. `beforeEach`/`afterEach` are kept outside `it.layer` because they manipulate `process.env.HOME` synchronously before the Effect runtime spins up. **This relies on `liveRegistryService` reading `process.env.HOME` lazily on every call rather than caching a derived path at layer-construction time** — verified against `src/services/registry-service.ts` at the time of writing. If the live impl ever caches a DB path during construction, the layer (which `it.layer` memoizes) would freeze the first test's `tempDir` and subsequent tests would hit a deleted directory. Re-verify this assumption when modifying `registry-service.ts`.

- [ ] **Step 2: Stop the session so the hook runs lint + tests**

Do not run `bun run test` directly. The Stop hook handles validation. Three test cases in this file should still pass; an unrelated regression in any other file would also surface.

If the hook reports `Service not found in context` for `RegistryService`, the most likely cause is a typo in the layer wiring from Task 3 — re-check `tests/helpers/effect-vitest.ts`.

- [ ] **Step 3: Commit**

```bash
git add tests/services/registry-service.test.ts
git commit -m "test: migrate registry-service tests to @effect/vitest"
```

---

### Task 5: Document the testing pattern in EFFECT_V4.md

**Files:**
- Modify: `EFFECT_V4.md`

- [ ] **Step 1: Append a new section**

Append the following section to the end of `EFFECT_V4.md` (or insert it before any existing trailing references section — pick a sensible spot consistent with the existing document structure):

```markdown
## Testing with @effect/vitest

We use `@effect/vitest@4.0.0-beta.59` for Effect-aware tests. Two patterns coexist; pick based on what the test needs:

### `it.effect` + `it.layer` — preferred for new tests

```ts
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { WorktreeService } from "../src/services/worktree-service";
import { WctTestLayer } from "./helpers/effect-vitest";

describe("getCurrentBranch", () => {
  it.layer(WctTestLayer)("in a temp git repo", (it) => {
    it.effect("returns the active branch", () =>
      Effect.gen(function* () {
        const wt = yield* WorktreeService;
        const branch = yield* wt.getCurrentBranch();
        expect(branch).toBe("main");
      }),
    );
  });
});
```

For per-test service overrides, use `wctTestLayer({ tmux: fakeTmux })` instead of `WctTestLayer`. The overrides shape matches the existing `withTestServices` helper.

### `runBunPromise` + `withTestServices` — keep using when

- The test mixes imperative `vi.spyOn` mocks with the Effect call (e.g. spying on `console.log`).
- The test composes multiple `Effect.runPromise` calls with intervening synchronous mutation.
- You're touching an existing test file and don't want to expand the diff.

Both patterns are correct; do not bulk-migrate. Migrate opportunistically when editing an Effect-aware file.
```

- [ ] **Step 2: Commit**

```bash
git add EFFECT_V4.md
git commit -m "docs: document @effect/vitest testing pattern"
```

---

## Self-Review Notes

Spec coverage check (against the proposal accepted in conversation):

- ✅ Add `@effect/vitest@4.0.0-beta.59` as devDependency — Task 1.
- ✅ Update CLAUDE.md allowlist — Task 2.
- ✅ Convert one file as canonical example — Task 4 (`tests/services/registry-service.test.ts`, chosen because it is small, Effect-only, and free of `vi.spyOn` complications).
- ✅ Leave the other ~30 test files untouched — coexistence policy explicit, no bulk rewrite.
- ✅ Establish reusable infrastructure — `WctTestLayer` / `wctTestLayer` helper in Task 3 mirrors the existing `withTestServices` overrides shape so future migrations are mechanical.
- ✅ Document the pattern — Task 5 adds a section to `EFFECT_V4.md` so future contributors know which pattern to reach for.

Type consistency check:

- `WctTestLayer` (constant) is referenced in Tasks 3, 4, and 5 with identical capitalization.
- `wctTestLayer(overrides)` (function) is referenced in Tasks 3 and 5 with identical signature.
- `ServiceOverrides` is **imported** (not duplicated) from `tests/helpers/services.ts:42-51` and re-exported from `tests/helpers/effect-vitest.ts`. This eliminates drift on rename or signature change of existing keys. For new optional keys, the helper ships a compile-time exhaustiveness assertion (`_AssertOverridesExhaustive` / `_HandledOverrideKeys`) that fails to typecheck if `ServiceOverrides` grows a key not handled by `wctTestLayer` — turning silent runtime drift into a build-time error.
- `RegistryService` import path in Task 4 (`../../src/services/registry-service`) matches the existing source location.

Risks and mitigations:

- **Vitest 4 / @effect/vitest 4 compatibility**: peer-dep range is `^3 || ^4`; project is on `vitest@4.1.0`. The smoke check in Task 1 Step 3 fails fast if there's an ABI issue.
- **BunRuntime vs default runtime**: `it.effect` uses the default Effect runtime, not `BunRuntime`. Live wct services (`WorktreeService`, `TmuxService`, `GitHubService`, etc.) call into `execProcess` from `src/services/process.ts`, which depends on `ChildProcess` from `effect/unstable/process` — a service supplied by `BunServices.layer`. To match what `runBunPromise(withTestServices(...))` provides, both `WctTestLayer` and `wctTestLayer(...)` merge in `BunServices.layer`. The Task 3 sanity test exercises an `execProcess`-bound method on purpose, so a missing platform-service binding fails fast there rather than in a later test.
- **Hook collision**: PostToolUse `biome format --write` may rewrite the new files. The plan's code blocks already follow Biome conventions (sorted imports, double-quoted strings, trailing commas) to minimize churn.

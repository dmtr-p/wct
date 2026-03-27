# TUI Effect Service Branch Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish `codex-use-effect-for-tui` so it is ready to merge by keeping its safer behavior, porting the two good cleanup ideas from `move-all-tui-actions-implementations-to-effect-services`, and hardening the TUI lifecycle and hook coverage.

**Architecture:** Keep `codex-use-effect-for-tui` as the behavioral baseline. Narrow the TUI `ManagedRuntime` to only the services the TUI actually consumes, simplify the one-shot `OpenModal` branch fetch to a promise-based boundary, then audit TUI runtime disposal and add targeted hook-level tests without reintroducing the regressions found in `useRegistry`, `notify`, or `getDefaultBranch`.

**Tech Stack:** Effect v4 (`ManagedRuntime`, `Layer`, `ServiceMap.Service`), Bun, React/Ink, Vitest

---

### Task 1: Narrow the TUI runtime layer and remove the cast

**Files:**
- Modify: `src/tui/runtime.ts`
- Test: `bun test tests/tmui.test.ts` (sanity typo check: do not use; run the exact commands below instead)
- Test: `bun test tests/tui/use-github.test.ts tests/tui/use-registry.test.ts tests/tmux.test.ts`

- [ ] **Step 1: Inspect current TUI runtime dependencies**

Run:

```bash
rg -n "tuiRuntime|HooksService|IdeService|SetupService|VSCodeWorkspaceService" src/tui src/commands
```

Expected:
- `tuiRuntime` usages only in TUI hooks/components
- no current TUI consumer requiring `HooksService`, `IdeService`, `SetupService`, or `VSCodeWorkspaceService`

- [ ] **Step 2: Write the narrowed runtime implementation**

Update `src/tui/runtime.ts` to this shape:

```ts
import { BunServices } from "@effect/platform-bun";
import { Layer, ManagedRuntime } from "effect";
import { GitHubService, liveGitHubService } from "../services/github-service";
import { liveQueueStorage, QueueStorage } from "../services/queue-storage";
import {
  liveRegistryService,
  RegistryService,
} from "../services/registry-service";
import { liveTmuxService, TmuxService } from "../services/tmux";
import {
  liveWorktreeService,
  WorktreeService,
} from "../services/worktree-service";

const tuiLayer = Layer.mergeAll(
  Layer.succeed(TmuxService, liveTmuxService),
  Layer.succeed(WorktreeService, liveWorktreeService),
  Layer.succeed(GitHubService, liveGitHubService),
  Layer.succeed(QueueStorage, liveQueueStorage),
  Layer.succeed(RegistryService, liveRegistryService),
  BunServices.layer,
);

export const tuiRuntime = ManagedRuntime.make(tuiLayer);
```

Requirements:
- remove the `WctServices` import
- remove `HooksService`, `IdeService`, `SetupService`, and `VSCodeWorkspaceService`
- remove the explicit `ManagedRuntime.ManagedRuntime<WctServices, never>` annotation
- remove the `as Layer.Layer<WctServices>` cast

- [ ] **Step 3: Run focused tests**

Run:

```bash
bun test tests/tui/use-github.test.ts tests/tui/use-registry.test.ts tests/tmux.test.ts
```

Expected:
- PASS

- [ ] **Step 4: Run the wider targeted regression suite**

Run:

```bash
bun test tests/tmux.test.ts tests/worktree.test.ts tests/tui/use-github.test.ts tests/tui/use-registry.test.ts tests/queue-service.test.ts
```

Expected:
- PASS

- [ ] **Step 5: Commit the runtime cleanup**

```bash
git add src/tui/runtime.ts
git commit -m "refactor(tui): narrow managed runtime to used services"
```

### Task 2: Simplify OpenModal branch loading

**Files:**
- Modify: `src/tui/components/OpenModal.tsx`
- Test: `bun test tests/tmux.test.ts tests/worktree.test.ts`

- [ ] **Step 1: Inspect the current branch-loading effect**

Run:

```bash
nl -ba src/tui/components/OpenModal.tsx | sed -n '500,560p'
```

Expected:
- current code uses `tuiRuntime.runFork(...)`
- `Effect.tap(...)` and `Fiber.interrupt(...)` are present for a one-shot fetch

- [ ] **Step 2: Replace fiber orchestration with a promise boundary**

Update the branch-loading effect in `src/tui/components/OpenModal.tsx` to this shape:

```ts
  useEffect(() => {
    let cancelled = false;
    tuiRuntime
      .runPromise(WorktreeService.use((s) => s.listBranches(repoPath)))
      .then((result) => {
        if (!cancelled) {
          setBranches(result);
        }
      })
      .catch(() => {
        // Ignore branch listing errors
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);
```

Also clean up imports:
- remove `Effect` and `Fiber` if they become unused
- keep `WorktreeService` and `tuiRuntime`

- [ ] **Step 3: Verify lint-level cleanliness through the relevant tests**

Run:

```bash
rg -n 'from "effect"' src/tui/components/OpenModal.tsx
```

Expected:
- no `Effect` or `Fiber` import remains in `src/tui/components/OpenModal.tsx`

Run:

```bash
bunx biome check --write src/tui/components/OpenModal.tsx
```

Expected:
- no remaining import-order, unused-import, or formatting issues in `OpenModal.tsx`

Run:

```bash
bun test tests/worktree.test.ts tests/tui/use-registry.test.ts
```

Expected:
- PASS

- [ ] **Step 4: Re-run the branch-completion regression suite**

Run:

```bash
bun test tests/tmux.test.ts tests/worktree.test.ts tests/tui/use-github.test.ts tests/tui/use-registry.test.ts tests/queue-service.test.ts
```

Expected:
- PASS

- [ ] **Step 5: Commit the React/Effect boundary cleanup**

```bash
git add src/tui/components/OpenModal.tsx
git commit -m "refactor(tui): simplify open modal branch loading"
```

### Task 3: Audit TUI runtime disposal and make the lifecycle decision explicit

**Files:**
- Inspect: `src/commands/tui.ts`
- Inspect: `src/tui/App.tsx`
- Inspect: `src/tui/runtime.ts`
- Create or Modify: `tests/tui/runtime-lifecycle.test.ts`
- Modify if needed: `src/commands/tui.ts`

- [ ] **Step 1: Inspect how the TUI starts and stops**

Run:

```bash
nl -ba src/commands/tui.ts | sed -n '1,240p'
```

Run:

```bash
nl -ba src/tui/App.tsx | sed -n '1,260p'
```

Expected:
- enough context to determine whether the runtime has an explicit teardown point after Ink exits

- [ ] **Step 2: Decide which lifecycle branch applies**

Choose exactly one:

Option A, explicit disposal is needed:
- there is a clear async shutdown path after Ink exits
- runtime-owned resources could outlive the UI session without explicit disposal

Option B, explicit disposal is intentionally omitted:
- the process exits immediately after TUI completion
- the current `ManagedRuntime` use does not leave meaningful long-lived resources past process exit

Record the decision in code and tests. Do not leave this as tribal knowledge.

- [ ] **Step 3A: If disposal is needed, write the failing lifecycle test**

Create `tests/tui/runtime-lifecycle.test.ts` with a test shaped like:

```ts
import { describe, expect, test, vi } from "vitest";

describe("tui runtime lifecycle", () => {
  test("disposes the managed runtime when the TUI command exits", async () => {
    const dispose = vi.fn(async () => {});

    await runTuiCommandForTest({
      runtime: { dispose },
    });

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
```

Use the real command structure and adapt the helper name to the actual code after inspection. The purpose of the test is to prove the teardown point, not to invent a new architecture.

- [ ] **Step 4A: If disposal is needed, implement the minimal teardown**

Modify the command shutdown path to call:

```ts
await tuiRuntime.dispose();
```

Implementation constraints:
- call it in the same lifecycle that currently owns TUI startup
- do not add disposal in multiple places
- preserve current success and error behavior

- [ ] **Step 5A: If disposal is needed, run the lifecycle test and regression suite**

Run:

```bash
bun test tests/tui/runtime-lifecycle.test.ts
```

Expected:
- PASS

Run:

```bash
bun test tests/tmux.test.ts tests/worktree.test.ts tests/tui/use-github.test.ts tests/tui/use-registry.test.ts tests/queue-service.test.ts tests/tui/runtime-lifecycle.test.ts
```

Expected:
- PASS

- [ ] **Step 6A: If disposal is needed, commit the lifecycle fix**

```bash
git add src/commands/tui.ts tests/tui/runtime-lifecycle.test.ts
git commit -m "fix(tui): dispose managed runtime on shutdown"
```

- [ ] **Step 3B: If disposal is intentionally omitted, write the audit test or documentation guard**

Create `tests/tui/runtime-lifecycle.test.ts` with a documentation-style assertion or command-level test that captures the chosen lifecycle contract. Example shape:

```ts
import { describe, expect, test } from "vitest";
import * as tuiCommandModule from "../../src/commands/tui";
import { tuiRuntime } from "../../src/tui/runtime";

describe("tui runtime lifecycle", () => {
  test("keeps the managed runtime process-scoped with no explicit dispose path", () => {
    expect(typeof tuiRuntime.dispose).toBe("function");
    expect(String(tuiCommandModule.startTui ?? tuiCommandModule.command)).not.toContain(
      ".dispose(",
    );
  });
});
```

Adapt the symbol names to the actual exported command structure discovered in Step 1. The final test must assert the current ownership model using real module exports and the absence of an explicit disposal call in the TUI startup/shutdown flow. Do not leave behind a trivial placeholder assertion.

If `String(fn)` does not produce readable source under Bun/Vitest, use a fallback assertion that reads the source file text or shells out to:

```bash
rg -n "\.dispose\(" src/commands/tui.ts src/tui/App.tsx
```

The final test or audit proof must still be automated and must still assert the absence of an explicit disposal path in the chosen ownership point.

- [ ] **Step 4B: If disposal is intentionally omitted, make the decision explicit in code**

Add a short comment at the TUI startup/shutdown ownership point, for example:

```ts
// The TUI runtime is process-scoped here; we intentionally do not call
// tuiRuntime.dispose() because command exit tears down the process.
```

Place the comment only where the lifecycle decision is owned.

- [ ] **Step 5B: If disposal is intentionally omitted, run the lifecycle test and regression suite**

Run:

```bash
bun test tests/tui/runtime-lifecycle.test.ts
```

Expected:
- PASS

Run:

```bash
bun test tests/tmux.test.ts tests/worktree.test.ts tests/tui/use-github.test.ts tests/tui/use-registry.test.ts tests/queue-service.test.ts tests/tui/runtime-lifecycle.test.ts
```

Expected:
- PASS

- [ ] **Step 6B: If disposal is intentionally omitted, commit the explicit lifecycle decision**

```bash
git add src/commands/tui.ts tests/tui/runtime-lifecycle.test.ts
git commit -m "test(tui): document runtime lifecycle decision"
```

### Task 4: Add hook-level tests for useGitHub orchestration

**Files:**
- Create: `tests/tui/use-github-hook.test.ts`
- Inspect: `src/tui/hooks/useGitHub.ts`
- Test: `bun test tests/tui/use-github.test.ts tests/tui/use-github-hook.test.ts`

- [ ] **Step 1: Inspect the hook contract**

Run:

```bash
nl -ba src/tui/hooks/useGitHub.ts | sed -n '1,220p'
```

Expected:
- identify refresh flow, polling behavior, empty-repo short circuit, and partial check-fetch failure handling

- [ ] **Step 2: Write failing tests for the observable hook behaviors**

Create `tests/tui/use-github-hook.test.ts` covering at least:

```ts
import { describe, expect, test, vi } from "vitest";

describe("useGitHub", () => {
  test("does not fetch when repo list is empty", async () => {
    // render hook with []
    // expect no service calls
  });

  test("keeps PR entries when check fetch fails for one PR", async () => {
    // listPrs succeeds
    // one listPrChecks call rejects
    // result still includes the PR with checks: []
  });

  test("clears loading after refresh completes", async () => {
    // observe loading true -> false
  });
});
```

Implementation notes:
- mock `tuiRuntime.runPromise`
- mock the module-level runtime import directly with `vi.mock("../../src/tui/runtime", ...)`
- use the repo’s existing Vitest style
- prefer one test per externally visible behavior

- [ ] **Step 3: Run the new hook tests to verify they fail for the right reason**

Run:

```bash
bun test tests/tui/use-github-hook.test.ts
```

Expected:
- FAIL because the test file or hook harness is not complete yet

- [ ] **Step 4: Implement the minimal test harness/helpers**

Add only the support needed for the tests:

```ts
vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn(),
  },
}));
```

If the repo does not already have a hook-testing utility, write a minimal local helper in the test file rather than introducing a new dependency. Prefer mocking the module boundary (`tuiRuntime`) over trying to mock individual Effect services.

Use a manual React render harness shaped like:

```ts
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

function renderUseGitHub(repos: RepoInfo[]) {
  let latest: ReturnType<typeof useGitHub> | undefined;

  function TestComponent() {
    latest = useGitHub(repos);
    return null;
  }

  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<TestComponent />);
  });

  return {
    get value() {
      if (!latest) {
        throw new Error("Hook value not captured");
      }
      return latest;
    },
    rerender(nextRepos: RepoInfo[]) {
      act(() => {
        renderer.update(<TestComponent />);
      });
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
    },
  };
}
```

Adapt the helper to the actual hook signature and state update needs. The key requirement is: mount a tiny component that calls the hook, capture the latest hook value, and drive effects through `act(...)`.

- [ ] **Step 5: Run the focused GitHub hook tests**

Run:

```bash
bun test tests/tui/use-github.test.ts tests/tui/use-github-hook.test.ts
```

Expected:
- PASS

- [ ] **Step 6: Commit the GitHub hook coverage**

```bash
git add tests/tui/use-github.test.ts tests/tui/use-github-hook.test.ts
git commit -m "test(tui): cover github hook refresh behavior"
```

### Task 5: Add hook-level tests for useTmux orchestration

**Files:**
- Create: `tests/tui/use-tmux.test.ts`
- Inspect: `src/tui/hooks/useTmux.ts`
- Test: `bun test tests/tui/use-tmux.test.ts tests/tmux.test.ts`

- [ ] **Step 1: Inspect the hook contract**

Run:

```bash
nl -ba src/tui/hooks/useTmux.ts | sed -n '1,240p'
```

Expected:
- identify client discovery states, session refresh, pane refresh, and boolean return paths for `switchSession` and `jumpToPane`

- [ ] **Step 2: Write failing tests for client-state behavior**

Create `tests/tui/use-tmux.test.ts` covering at least:

```ts
import { describe, expect, test } from "vitest";

describe("useTmux", () => {
  test("reports an error when no tmux client is found", async () => {
    // listClients -> []
    // expect error message and client === null
  });

  test("stores the single client when exactly one tmux client is found", async () => {
    // listClients -> [client]
    // expect client set and error cleared
  });

  test("reports a multi-client error when more than one client exists", async () => {
    // listClients -> [a, b]
    // expect error and client === null
  });
});
```

- [ ] **Step 3: Add failing tests for navigation return values**

Extend `tests/tui/use-tmux.test.ts` with:

```ts
  test("switchSession returns false when no active client exists", async () => {
    // client === null
    // expect false
  });

  test("jumpToPane returns false when runtime navigation fails", async () => {
    // client exists
    // switch call rejects
    // expect false
  });
```

- [ ] **Step 4: Run the new tmux hook tests to verify they fail first**

Run:

```bash
bun test tests/tui/use-tmux.test.ts
```

Expected:
- FAIL before the harness/mocks are completed

- [ ] **Step 5: Implement the minimal test harness and mocks**

Use local mocks around `tuiRuntime.runPromise` via `vi.mock("../../src/tui/runtime", ...)` and trigger the hook’s startup `useEffect`. Do not introduce new runtime dependencies. Keep the test helper local unless both hook suites clearly need the same helper.

Use the same minimal React render harness pattern as Task 4, for example:

```ts
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

function renderUseTmux() {
  let latest: ReturnType<typeof useTmux> | undefined;

  function TestComponent() {
    latest = useTmux();
    return null;
  }

  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<TestComponent />);
  });

  return {
    get value() {
      if (!latest) {
        throw new Error("Hook value not captured");
      }
      return latest;
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
    },
  };
}
```

Drive async state transitions by awaiting queued promises and wrapping updates in `act(...)`.

- [ ] **Step 6: Run focused tmux hook tests and parser tests**

Run:

```bash
bun test tests/tui/use-tmux.test.ts tests/tmux.test.ts
```

Expected:
- PASS

- [ ] **Step 7: Commit the tmux hook coverage**

```bash
git add tests/tui/use-tmux.test.ts tests/tmux.test.ts
git commit -m "test(tui): cover tmux hook client and navigation states"
```

### Task 6: Final verification before merge

**Files:**
- Inspect: `git diff --stat`
- Verify: existing modified files plus new test files

- [ ] **Step 1: Run the branch-completion test suite**

Run:

```bash
bun test tests/tmux.test.ts tests/worktree.test.ts tests/tui/use-github.test.ts tests/tui/use-github-hook.test.ts tests/tui/use-registry.test.ts tests/tui/use-tmux.test.ts tests/queue-service.test.ts tests/tui/runtime-lifecycle.test.ts
```

Expected:
- PASS

- [ ] **Step 2: Run formatting/linting**

Run:

```bash
bunx biome check --write src tests
```

Expected:
- no remaining formatting or lint issues

- [ ] **Step 3: Re-run the full test suite**

Run:

```bash
bun test
```

Expected:
- PASS

- [ ] **Step 4: Inspect the final diff and commit graph**

Run:

```bash
git diff --stat main...
```

Run:

```bash
git log --oneline --decorate -n 12
```

Expected:
- small, reviewable commits matching the tasks above

- [ ] **Step 5: Prepare the merge summary**

Capture:
- runtime narrowed without cast
- `OpenModal` simplified
- lifecycle decision made explicit
- hook-level tests added for GitHub and tmux
- existing safer `useRegistry`, `notify`, and `getDefaultBranch` behavior preserved

No commit in this step; this is the handoff note for the merge/review phase.

---

## Self-Review

- Spec coverage: the plan covers the agreed base branch, the two ports from `move-all...`, the lifecycle audit, and the missing hook-level tests.
- Placeholder scan: no `TODO` or `TBD` placeholders remain, but Task 3 intentionally branches on an audit result. The implementation worker must choose exactly one path and complete only that path.
- Type consistency: the plan keeps the existing service and hook names from the branch and does not rename interfaces or methods.

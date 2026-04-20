# TUI Open In-Process Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the TUI `open` subprocess handoff with direct in-process execution while preserving CLI behavior, PR-based open support, and tmux safety.

**Architecture:** Extract two shared command-level Effects in `src/commands/open.ts`: one to normalize branch-or-PR input into `OpenOptions`, and one to run the open workflow while keeping the existing streamed logger output. Rewire the CLI root command and the TUI modal action to call those shared Effects directly, with the TUI path forcing `noAttach: true` and silencing Effect `Console` output through the repo’s existing `Effect.provideService(..., Console.Console, ...)` pattern.

**Tech Stack:** Effect v4, Bun, Ink/React, Vitest

---

### Task 1: Introduce shared open request and result types in `src/commands/open.ts`

**Files:**
- Modify: `src/commands/open.ts`

- [ ] **Step 1: Inspect the current `open` command boundary and the TUI caller**

Run:

```bash
nl -ba src/commands/open.ts | sed -n '1,260p'
```

Run:

```bash
nl -ba src/tui/hooks/useModalActions.ts | sed -n '80,170p'
```

Expected:
- `src/commands/open.ts` exports `OpenOptions` and `openCommand(...)`
- `createHandleOpen(...)` still shells out with `Bun.spawn(["wct", ...])`

- [ ] **Step 2: Add the shared request and result types**

Update `src/commands/open.ts` near the existing `OpenOptions` export to introduce these types:

```ts
export interface OpenRequest {
  branch?: string;
  existing?: boolean;
  base?: string;
  noIde?: boolean;
  noAttach?: boolean;
  pr?: string;
  prompt?: string;
  profile?: string;
}

export interface OpenWorktreeResult {
  worktreePath: string;
  branch: string;
  sessionName: string;
  projectName: string;
  created: boolean;
}
```

Requirements:
- keep `OpenOptions` as the normalized branch-based input used by the workflow
- keep `commandDef` unchanged in this task
- do not move code to a new module

- [ ] **Step 3: Add placeholder exports for the shared resolver and workflow names without changing behavior yet**

In `src/commands/open.ts`, add exported function shells with the final signatures and temporary `Effect.fail(...)` bodies:

```ts
export function resolveOpenOptions(
  input: OpenRequest,
): Effect.Effect<OpenOptions, WctError, WctServices> {
  return Effect.fail(commandError("invalid_options", "not implemented"));
}

export function openWorktree(
  options: OpenOptions,
): Effect.Effect<OpenWorktreeResult, WctError, WctServices> {
  return Effect.fail(commandError("worktree_error", "not implemented"));
}
```

Requirements:
- leave `openCommand(...)` intact for now
- use the exact exported names from the approved spec

- [ ] **Step 4: Update type-only imports or compile-time references affected by the new exports**

Run:

```bash
rg -n "OpenRequest|OpenWorktreeResult|resolveOpenOptions|openWorktree" src tests
```

Expected:
- only the new definitions in `src/commands/open.ts` appear at this point

- [ ] **Step 5: End the task and let the repo hooks run**

Expected on session stop:
- formatting runs automatically
- lint/test hooks report no failures caused by the new type additions

- [ ] **Step 6: Commit the shared type scaffold**

```bash
git add src/commands/open.ts
git commit -m "refactor(open): add shared request and result types"
```

### Task 2: Extract PR-aware option normalization into `resolveOpenOptions(...)`

**Files:**
- Modify: `src/commands/open.ts`
- Modify: `src/cli/root-command.ts`
- Create: `tests/open.test.ts`

- [ ] **Step 1: Inspect the current PR preprocessing logic in the CLI root command**

Run:

```bash
nl -ba src/cli/root-command.ts | sed -n '220,310p'
```

Expected:
- inline `--pr` validation
- `parsePrArg(...)`, `GitHubService.resolvePr(...)`, remote detection/addition, fetch, and `branchExists(...)`
- final call into `openCommand(...)`

- [ ] **Step 2: Import the GitHub helpers needed by the shared resolver**

Update the import section at the top of `src/commands/open.ts` to include `GitHubService` and `parsePrArg`:

```ts
import { GitHubService, parsePrArg } from "../services/github-service";
```

Requirements:
- keep existing service imports
- avoid duplicate imports of `GitHubService` elsewhere in the file

- [ ] **Step 3: Implement `resolveOpenOptions(...)` by moving the current branch-or-PR logic out of `root-command.ts`**

Replace the placeholder in `src/commands/open.ts` with this structure:

```ts
export function resolveOpenOptions(
  input: OpenRequest,
): Effect.Effect<OpenOptions, WctError, WctServices> {
  return Effect.gen(function* () {
    const {
      branch,
      existing = false,
      base,
      noIde,
      noAttach,
      pr,
      prompt,
      profile,
    } = input;

    if (pr && branch) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Cannot use --pr together with a branch argument",
        ),
      );
    }

    if (pr && base) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Cannot use --pr together with --base",
        ),
      );
    }

    if (pr) {
      const prNumber = parsePrArg(pr);
      if (prNumber === null) {
        return yield* Effect.fail(
          commandError(
            "pr_error",
            `Invalid --pr value: '${pr}'\n\nExpected a PR number or GitHub URL (e.g. 123 or https://github.com/user/repo/pull/123)`,
          ),
        );
      }

      const ghInstalled = yield* GitHubService.use((service) =>
        service.isGhInstalled(),
      );
      if (!ghInstalled) {
        return yield* Effect.fail(
          commandError(
            "gh_not_installed",
            "GitHub CLI (gh) is not installed.\n\nInstall it from https://cli.github.com/ and run 'gh auth login'",
          ),
        );
      }

      const resolvedPr = yield* GitHubService.use((service) =>
        service.resolvePr(prNumber),
      );
      const resolvedBranch = resolvedPr.branch;
      let remote = "origin";

      if (resolvedPr.headOwner && resolvedPr.headRepo) {
        const { headOwner, headRepo } = resolvedPr;
        const existingRemote = yield* GitHubService.use((service) =>
          service.findRemoteForRepo(headOwner, headRepo),
        );

        if (existingRemote) {
          remote = existingRemote;
        } else if (resolvedPr.isCrossRepository) {
          remote = headOwner;
          yield* GitHubService.use((service) =>
            service.addForkRemote(remote, headOwner, headRepo),
          );
        }
      }

      yield* GitHubService.use((service) =>
        service.fetchBranch(resolvedBranch, remote),
      );

      const localExists = yield* WorktreeService.use((service) =>
        service.branchExists(resolvedBranch),
      );

      return {
        branch: resolvedBranch,
        existing: localExists,
        base: localExists ? undefined : `${remote}/${resolvedBranch}`,
        noIde,
        noAttach,
        prompt,
        profile,
      };
    }

    if (!branch) {
      return yield* Effect.fail(
        commandError("missing_branch_arg", "Missing branch name"),
      );
    }

    return {
      branch,
      existing,
      base,
      noIde,
      noAttach,
      prompt,
      profile,
    };
  });
}
```

Requirements:
- keep the same messages and error tags currently emitted from `root-command.ts`
- preserve same-repo vs fork-PR remote behavior
- keep the guarded destructure pattern for `headOwner` and `headRepo` so the code typechecks under strict nullability
- do not add new runtime dependencies

- [ ] **Step 4: Simplify `src/cli/root-command.ts` to delegate into `resolveOpenOptions(...)`**

Replace the current inline `open` command handler branch with this shape:

```ts
  ({ branch, base, existing, noIde, noAttach, pr, prompt, profile }) =>
    Effect.gen(function* () {
      const options = yield* resolveOpenOptions({
        branch: optionToUndefined(branch),
        existing,
        base: optionToUndefined(base),
        noIde,
        noAttach,
        pr: optionToUndefined(pr),
        prompt: optionToUndefined(prompt),
        profile: optionToUndefined(profile),
      });

      return yield* openCommand(options);
    }),
```

Also update imports:
- remove direct `GitHubService` and `parsePrArg` imports from `src/cli/root-command.ts`
- import `resolveOpenOptions` from `../commands/open`

- [ ] **Step 5: Add concrete unit coverage for the extracted resolver**

Create `tests/open.test.ts` with these tests:

```ts
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { resolveOpenOptions } from "../src/commands/open";
import { runBunPromise } from "../src/effect/runtime";
import { liveGitHubService } from "../src/services/github-service";
import { liveWorktreeService } from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

describe("resolveOpenOptions", () => {
  test("rejects branch plus --pr", async () => {
    await expect(
      runBunPromise(
        withTestServices(
          resolveOpenOptions({
            branch: "feature/a",
            pr: "123",
          }),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "WctCommandError",
      code: "invalid_options",
      message: "Cannot use --pr together with a branch argument",
    });
  });

  test("converts a resolved PR into branch/base flags", async () => {
    const fetchCalls: Array<{ branch: string; remote?: string }> = [];

    const result = await runBunPromise(
      withTestServices(
        resolveOpenOptions({
          pr: "123",
          noIde: true,
          prompt: "ship-it",
        }),
        {
          github: {
            ...liveGitHubService,
            isGhInstalled: () => Effect.succeed(true),
            resolvePr: () =>
              Effect.succeed({
                branch: "feature/pr-123",
                prNumber: 123,
                isCrossRepository: false,
              }),
            findRemoteForRepo: () => Effect.succeed(null),
            addForkRemote: () => Effect.void,
            fetchBranch: (branch, remote) =>
              Effect.sync(() => {
                fetchCalls.push({ branch, remote });
              }),
          },
          worktree: {
            ...liveWorktreeService,
            branchExists: () => Effect.succeed(false),
          },
        },
      ),
    );

    expect(result).toEqual({
      branch: "feature/pr-123",
      existing: false,
      base: "origin/feature/pr-123",
      noIde: true,
      noAttach: undefined,
      prompt: "ship-it",
      profile: undefined,
    });
    expect(fetchCalls).toEqual([
      { branch: "feature/pr-123", remote: "origin" },
    ]);
  });
});
```

Requirements:
- cover both invalid-option and successful-PR normalization paths
- use existing test helpers/service injection patterns already present in the repo

- [ ] **Step 6: End the task and let the repo hooks run**

Expected on session stop:
- formatting runs automatically
- lint/test hooks validate the resolver extraction and CLI rewiring

- [ ] **Step 7: Commit the shared option resolver**

```bash
git add src/commands/open.ts src/cli/root-command.ts tests/open.test.ts
git commit -m "refactor(open): share pr option resolution"
```

### Task 3: Extract the logged open workflow into `openWorktree(...)` and slim down `openCommand(...)`

**Files:**
- Modify: `src/commands/open.ts`
- Inspect: `src/commands/worktree-session.ts`
- Modify: `tests/open.test.ts`

- [ ] **Step 1: Inspect the current workflow body and the `startWorktreeSession(...)` template**

Run:

```bash
nl -ba src/commands/open.ts | sed -n '70,260p'
```

Run:

```bash
nl -ba src/commands/worktree-session.ts | sed -n '75,190p'
```

Expected:
- `openCommand(...)` still contains the whole workflow
- `startWorktreeSession(...)` shows the desired “shared Effect first, caller-specific behavior later” pattern

- [ ] **Step 2: Move the orchestration body into `openWorktree(...)`**

Implement `openWorktree(...)` by moving the current body of `openCommand(...)` into the shared function and returning a small result object at the end:

```ts
export function openWorktree(
  options: OpenOptions,
): Effect.Effect<OpenWorktreeResult, WctError, WctServices> {
  return Effect.gen(function* () {
    const { branch, existing, base, noIde, noAttach, prompt, profile } =
      options;

    // keep all current validation, config loading, registry registration,
    // worktree creation, workspace sync, copy/setup, and launch behavior

    return {
      worktreePath,
      branch,
      sessionName,
      projectName: config.project_name,
      created: worktreeResult._tag !== "AlreadyExists",
    };
  });
}
```

Requirements:
- keep all existing `logger.info(...)`, `logger.success(...)`, and `logger.warn(...)` calls inside `openWorktree(...)`
- preserve current error messages and tags
- preserve `launchSessionAndIde(...)` behavior exactly

- [ ] **Step 3: Reduce `openCommand(...)` to a thin adapter**

Replace `openCommand(...)` with:

```ts
export function openCommand(
  options: OpenOptions,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.asVoid(openWorktree(options));
}
```

Requirements:
- keep the public export name unchanged for CLI callers
- do not duplicate any workflow logic back into `openCommand(...)`

- [ ] **Step 4: Make the return value observable for future callers without changing CLI behavior**

Run:

```bash
rg -n "openWorktree\\(|openCommand\\(" src tests
```

Expected:
- `openCommand(...)` remains the CLI-facing wrapper
- `openWorktree(...)` is ready for direct TUI use in the next task

- [ ] **Step 5: Add workflow-level tests around the new shared result**

Use a real tmp fixture for these tests so `loadConfig(mainDir)` can read an actual `.wct.yaml`. Follow the fixture pattern already used in `tests/worktree-session.test.ts` and `tests/up.test.ts`: create a temp repo directory, write a minimal `.wct.yaml`, and point `getMainRepoPath()` at that real path.

Add these tests to `tests/open.test.ts`:

```ts
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { openCommand, openWorktree } from "../src/commands/open";
import { runBunPromise } from "../src/effect/runtime";
import { liveIdeService } from "../src/services/ide-service";
import { liveRegistryService } from "../src/services/registry-service";
import { liveSetupService } from "../src/services/setup-service";
import { liveTmuxService } from "../src/services/tmux";
import { liveVSCodeWorkspaceService } from "../src/services/vscode-workspace";
import { liveWorktreeService } from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

async function createOpenFixture() {
  const repoDir = await realpath(await mkdtemp(join(tmpdir(), "wct-open-")));
  await Bun.write(
    join(repoDir, ".wct.yaml"),
    `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
`,
  );
  return { repoDir };
}

test("openWorktree returns created false when worktree already exists", async () => {
  const fixture = await createOpenFixture();
  try {
    const result = await runBunPromise(
      withTestServices(
        openWorktree({
          branch: "feature/existing",
          existing: true,
          noAttach: true,
        }),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(fixture.repoDir),
            branchExists: () => Effect.succeed(true),
            createWorktree: () => Effect.succeed({ _tag: "AlreadyExists" }),
          },
          registry: {
            ...liveRegistryService,
            register: () => Effect.void,
          },
          setup: {
            ...liveSetupService,
            runSetupCommands: () => Effect.succeed([]),
          },
          tmux: {
            ...liveTmuxService,
            createSession: () =>
              Effect.succeed({
                _tag: "Created" as const,
                sessionName: "feature-existing",
              }),
          },
          ide: {
            ...liveIdeService,
            openIDE: () => Effect.void,
          },
          vscodeWorkspace: {
            ...liveVSCodeWorkspaceService,
            syncWorkspaceState: () =>
              Effect.succeed({
                success: true,
                skipped: true,
              }),
          },
        },
      ),
    );

    expect(result).toEqual({
      worktreePath: expect.stringContaining("feature/existing"),
      branch: "feature/existing",
      sessionName: "feature-existing",
      projectName: "myapp",
      created: false,
    });
  } finally {
    await rm(fixture.repoDir, { recursive: true, force: true });
  }
});

test("openCommand delegates to openWorktree and resolves void", async () => {
  const fixture = await createOpenFixture();
  try {
    await expect(
      runBunPromise(
        withTestServices(
          openCommand({
            branch: "feature/existing",
            existing: true,
            noAttach: true,
          }),
          {
            worktree: {
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
              getMainRepoPath: () => Effect.succeed(fixture.repoDir),
              branchExists: () => Effect.succeed(true),
              createWorktree: () => Effect.succeed({ _tag: "AlreadyExists" }),
            },
            registry: {
              ...liveRegistryService,
              register: () => Effect.void,
            },
            setup: {
              ...liveSetupService,
              runSetupCommands: () => Effect.succeed([]),
            },
            tmux: {
              ...liveTmuxService,
              createSession: () =>
                Effect.succeed({
                  _tag: "Created" as const,
                  sessionName: "feature-existing",
                }),
            },
            ide: {
              ...liveIdeService,
              openIDE: () => Effect.void,
            },
            vscodeWorkspace: {
              ...liveVSCodeWorkspaceService,
              syncWorkspaceState: () =>
                Effect.succeed({
                  success: true,
                  skipped: true,
                }),
            },
          },
        ),
      ),
    ).resolves.toBeUndefined();
  } finally {
    await rm(fixture.repoDir, { recursive: true, force: true });
  }
});
```

Requirements:
- keep the new result small; do not assert copy/setup detail in the result
- use a real config-backed temp fixture so the shared workflow reaches the stubbed service boundaries

- [ ] **Step 6: End the task and let the repo hooks run**

Expected on session stop:
- formatting runs automatically
- lint/test hooks validate the extracted workflow boundary

- [ ] **Step 7: Commit the shared open workflow**

```bash
git add src/commands/open.ts tests/open.test.ts
git commit -m "refactor(open): extract shared open workflow"
```

### Task 4: Rewire the TUI open action to call the shared Effects with silent console output

**Files:**
- Modify: `src/tui/hooks/useModalActions.ts`
- Modify: `src/tui/runtime.ts`
- Modify: `tests/tui/modal-actions.test.ts`

- [ ] **Step 1: Inspect the current TUI runtime and modal-action test seam**

Run:

```bash
nl -ba src/tui/runtime.ts | sed -n '1,220p'
```

Run:

```bash
nl -ba tests/tui/modal-actions.test.ts | sed -n '170,320p'
```

Expected:
- `tuiRuntime` currently only exposes `runPromise(...)` in tests
- `createHandleOpen(...)` tests are still written around `Bun.spawn(...)`

- [ ] **Step 2: Add a helper that runs an Effect with a silent `Console` implementation**

Update `src/tui/runtime.ts` to export a small helper alongside `tuiRuntime`:

```ts
import { Console, Effect, Layer, ManagedRuntime } from "effect";

const noop = () => {};
const silentConsole: Console.Console = {
  ...globalThis.console,
  assert: noop,
  clear: noop,
  count: noop,
  countReset: noop,
  debug: noop,
  dir: noop,
  dirxml: noop,
  error: noop,
  group: noop,
  groupCollapsed: noop,
  groupEnd: noop,
  info: noop,
  log: noop,
  table: noop,
  time: noop,
  timeEnd: noop,
  timeLog: noop,
  trace: noop,
  warn: noop,
};

export function runTuiSilentPromise<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Promise<A> {
  return tuiRuntime.runPromise(
    Effect.provideService(effect, Console.Console, silentConsole),
  );
}
```

Requirements:
- keep the existing `tuiRuntime` export intact
- only silence `Console` for the specific open-action execution path
- do not globally suppress all runtime logging elsewhere in the TUI
- mirror the repo’s existing `Effect.provideService(..., Console.Console, ...)` pattern instead of inventing a separate logging abstraction

- [ ] **Step 3: Replace subprocess spawning in `createHandleOpen(...)` with direct shared Effect calls**

Update `src/tui/hooks/useModalActions.ts` so the `createHandleOpen(...)` implementation follows this shape:

```ts
import { openWorktree, resolveOpenOptions } from "../../commands/open";
import { runTuiSilentPromise } from "../runtime";

export function createHandleOpen(deps: ModalActionDeps) {
  return (opts: OpenModalResult) => {
    deps.setMode(Mode.Navigate);

    const project = deps.openModalRepoProject || "unknown";
    const key = pendingKey(project, opts.branch);
    deps.setPendingActions((prev) =>
      new Map(prev).set(key, {
        type: "opening",
        branch: opts.branch,
        project,
      }),
    );

    void (async () => {
      try {
        const resolved = await runTuiSilentPromise(
          resolveOpenOptions({
            branch: opts.branch || undefined,
            existing: opts.existing,
            base: opts.base || undefined,
            noIde: opts.noIde,
            noAttach: true,
            pr: opts.pr || undefined,
            prompt: opts.prompt || undefined,
            profile: opts.profile || undefined,
          }),
        );

        await runTuiSilentPromise(openWorktree(resolved));
        await deps.refreshAll();
      } catch (error) {
        deps.showActionError(toWctError(error).message);
      } finally {
        deps.setPendingActions((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }
    })();
  };
}
```

Requirements:
- force `noAttach: true` regardless of the modal checkbox value
- remove all `Bun.spawn(...)` code and the delayed clear-on-exit branch
- keep success behavior limited to refresh plus pending-action cleanup
- keep failure behavior limited to `showActionError(...)`

- [ ] **Step 4: Rewrite `tests/tui/modal-actions.test.ts` around the runtime helper instead of `Bun.spawn(...)`**

Replace the old spawn-based tests by mocking the new runtime helper export directly:

```ts
import * as runtime from "../../src/tui/runtime";

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn().mockResolvedValue(undefined),
  },
  runTuiSilentPromise: vi.fn(),
}));

// Reuse the existing makeDeps(...) helper in this file for handleOpen,
// refreshAll, setPendingActions, and showActionError setup.

test("handleOpen resolves options, forces noAttach, opens worktree, and refreshes", async () => {
  const runTuiSilentPromise = vi
    .fn()
    .mockResolvedValueOnce({
      branch: "feat",
      existing: false,
      noAttach: true,
    })
    .mockResolvedValueOnce({
      worktreePath: "/repo/feat",
      branch: "feat",
      sessionName: "feat",
      projectName: "proj",
      created: true,
    });

  vi.mocked(runtime.runTuiSilentPromise).mockImplementation(
    runTuiSilentPromise,
  );

  handleOpen({
    branch: "feat",
    base: "",
    pr: "",
    profile: "",
    prompt: "",
    existing: false,
    noIde: false,
    noAttach: false,
  });

  await vi.waitFor(() => {
    expect(runTuiSilentPromise).toHaveBeenCalledTimes(2);
    expect(refreshAll).toHaveBeenCalled();
  });
  expect(setPendingActions).toHaveBeenCalledTimes(2);
});

test("handleOpen shows the error message and clears pending when resolution fails", async () => {
  vi.mocked(runtime.runTuiSilentPromise).mockRejectedValue(new Error("boom"));

  handleOpen({
    branch: "feat",
    base: "",
    pr: "",
    profile: "",
    prompt: "",
    existing: false,
    noIde: false,
    noAttach: false,
  });

  await vi.waitFor(() => {
    expect(showActionError).toHaveBeenCalledWith("boom");
  });
  expect(refreshAll).not.toHaveBeenCalled();
  expect(setPendingActions).toHaveBeenCalledTimes(2);
});
```

Requirements:
- mock `runTuiSilentPromise(...)` instead of `Bun.spawn`
- assert the TUI no longer waits on process exit codes
- assert `noAttach: true` is enforced from the TUI path

- [ ] **Step 5: End the task and let the repo hooks run**

Expected on session stop:
- formatting runs automatically
- lint/test hooks validate the TUI direct-execution path

- [ ] **Step 6: Commit the TUI open refactor**

```bash
git add src/tui/hooks/useModalActions.ts src/tui/runtime.ts tests/tui/modal-actions.test.ts
git commit -m "refactor(tui): run open in process"
```

### Task 5: Final regression review and cleanup

**Files:**
- Inspect: `src/commands/open.ts`
- Inspect: `src/cli/root-command.ts`
- Inspect: `src/tui/hooks/useModalActions.ts`
- Inspect: `src/tui/runtime.ts`
- Inspect: `tests/open.test.ts`
- Inspect: `tests/tui/modal-actions.test.ts`

- [ ] **Step 1: Verify there is no remaining TUI subprocess handoff for `wct open`**

Run:

```bash
rg -n 'Bun\\.spawn.*wct|spawn.*wct' src
```

Expected:
- no match in `src/tui/hooks/useModalActions.ts`
- no remaining TUI `wct open` subprocess execution path

- [ ] **Step 2: Verify the CLI root command no longer duplicates PR resolution**

Run:

```bash
rg -n "parsePrArg|resolvePr\\(|findRemoteForRepo|addForkRemote|fetchBranch" src/cli/root-command.ts src/commands/open.ts
```

Expected:
- PR-resolution logic now lives in `src/commands/open.ts`
- `src/cli/root-command.ts` only delegates into `resolveOpenOptions(...)`

- [ ] **Step 3: Sanity-check the final shared boundary**

Run:

```bash
rg -n "export interface OpenRequest|export interface OpenWorktreeResult|export function resolveOpenOptions|export function openWorktree" src/commands/open.ts
```

Expected:
- all four shared exports are present in `src/commands/open.ts`

- [ ] **Step 4: End the task and let the repo hooks run**

Expected on session stop:
- formatting runs automatically
- lint/test hooks complete without failures

- [ ] **Step 5: Commit the final cleanup if this task made any changes**

```bash
git add src/commands/open.ts src/cli/root-command.ts src/tui/hooks/useModalActions.ts src/tui/runtime.ts tests/open.test.ts tests/tui/modal-actions.test.ts
git commit -m "test: finalize tui open in-process refactor"
```

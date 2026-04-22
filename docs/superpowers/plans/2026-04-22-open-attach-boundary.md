# Open Attach Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move tmux attach/switch behavior out of the shared `openWorktree(...)` flow so CLI `open` keeps current behavior while the TUI no longer passes `noAttach` into shared open logic.

**Architecture:** Keep `openWorktree(...)` responsible for worktree creation plus tmux/IDE startup, but return whether tmux startup actually produced a usable session. Let CLI `openCommand(...)` call `maybeAttachSession(...)` directly after `openWorktree(...)`, and let the TUI gate its own client handoff on the new `tmuxSessionStarted` result bit.

**Tech Stack:** Bun, Effect v4, Vitest, Ink/TUI hooks

---

## File Structure

- Modify: `src/commands/session.ts`
  - Remove attach behavior from `launchSessionAndIde(...)`.
  - Return tmux startup outcome so `openWorktree(...)` can decide whether attach or handoff is valid.
- Modify: `src/commands/open.ts`
  - Remove `noAttach` from shared open request/options.
  - Add `tmuxSessionStarted` to `OpenWorktreeResult`.
  - Move CLI attach behavior into `openCommand(...)`.
- Modify: `src/tui/hooks/useModalActions.ts`
  - Stop passing `noAttach` into `resolveOpenOptions(...)`.
  - Skip client discovery/switch when `openWorktree(...)` reports no tmux session.
- Modify: `tests/open.test.ts`
  - Cover the new shared result shape and CLI attach boundary.
- Modify: `tests/tui/modal-actions.test.ts`
  - Cover the updated TUI request shape and the skip-handoff case.

## Repo Constraints

- Do not run tests or lint manually.
- Formatting runs after file edits via hooks.
- Verification happens when the worker stops; repo hooks run `biome lint --write` and `bun run test`.
- Each task below still starts with a failing test edit, but the actual test execution is delegated to the repo hooks at the end of the task.

### Task 1: Refactor the command-layer attach boundary

**Files:**
- Modify: `tests/open.test.ts`
- Modify: `src/commands/session.ts`
- Modify: `src/commands/open.ts`

- [ ] **Step 1: Write the failing command-layer tests**

Add or update tests in `tests/open.test.ts` to lock the new boundary:

```ts
import { vi } from "vitest";

test("resolveOpenOptions no longer returns noAttach", async () => {
  await expect(
    runResolveOpenOptions({
      cwd: "/repo",
      pr: "123",
      noIde: true,
      prompt: "focus",
      profile: "default",
    }),
  ).resolves.toEqual({
    branch: "feature-from-pr",
    existing: false,
    base: "origin/feature-from-pr",
    cwd: "/repo",
    noIde: true,
    prompt: "focus",
    profile: "default",
  });
});

test("openWorktree reports tmuxSessionStarted false when no tmux config exists", async () => {
  const result = await runBunPromise(
    withTestServices(
      openWorktree({
        branch: "feature-branch",
        cwd: fixture.repoDir,
        existing: false,
      }),
    ),
  );

  expect(result.tmuxSessionStarted).toBe(false);
});

test("openCommand prints attach guidance when --no-attach is set and tmux started", async () => {
  const originalTmux = process.env.TMUX;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  delete process.env.TMUX;

  try {
    await expect(
      runBunPromise(
        withTestServices(
          openCommand({
            branch: "feature-branch",
            existing: false,
            noAttach: true,
            cwd: fixture.repoDir,
          }),
          {
            tmux: {
              ...liveTmuxService,
              createSession: () =>
                Effect.succeed({
                  _tag: "Created" as const,
                  sessionName: "myapp-feature-branch",
                }),
            },
          },
        ),
      ),
    ).resolves.toBeUndefined();

    const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
    expect(
      loggedLines.some((line) => line.includes("Attach to tmux session")),
    ).toBe(true);
  } finally {
    logSpy.mockRestore();
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
  }
});
```

Also add the negative CLI case in the same file:

```ts
test("openCommand skips maybeAttachSession when tmuxSessionStarted is false", async () => {
  const originalTmux = process.env.TMUX;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  delete process.env.TMUX;

  try {
    await expect(
      runBunPromise(
        withTestServices(
          openCommand({
            branch: "feature-branch",
            existing: false,
            cwd: fixture.repoDir,
          }),
        ),
      ),
    ).resolves.toBeUndefined();

    const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
    expect(
      loggedLines.some((line) => line.includes("Attach to tmux session")),
    ).toBe(false);
  } finally {
    logSpy.mockRestore();
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
  }
});
```

- [ ] **Step 2: Stop and let repo hooks run**

Verification mechanism for this repo:

```bash
# No manual test command.
# Stop the worker after this task's edits and let hooks run:
# - biome lint --write
# - bun run test
```

Expected before implementation: hook-driven `bun run test` fails because:

- `OpenWorktreeResult` does not have `tmuxSessionStarted`
- `resolveOpenOptions(...)` still returns `noAttach`
- `openCommand(...)` does not own attach behavior yet

- [ ] **Step 3: Change `launchSessionAndIde(...)` to return tmux startup state**

Update `src/commands/session.ts` so `launchSessionAndIde(...)` returns a small result object and no longer calls `maybeAttachSession(...)`:

```ts
export interface LaunchSessionAndIdeResult {
  tmuxSessionStarted: boolean;
}

export function launchSessionAndIde(opts: {
  sessionName: string;
  workingDir: string;
  tmuxConfig?: TmuxConfig;
  env: WctEnv;
  ideCommand?: string;
  noIde?: boolean;
}): Effect.Effect<LaunchSessionAndIdeResult, WctError, WctServices> {
  return Effect.gen(function* () {
    const [tmuxResult] = yield* Effect.all([
      tmuxConfig
        ? logger
            .info("Creating tmux session...")
            .pipe(
              Effect.andThen(
                Effect.catch(
                  TmuxService.use((service) =>
                    service.createSession(
                      sessionName,
                      workingDir,
                      tmuxConfig,
                      env,
                    ),
                  ).pipe(
                    Effect.tap((result) =>
                      result._tag === "AlreadyExists"
                        ? logger.info(
                            `Tmux session '${sessionName}' already exists`,
                          )
                        : logger.success(
                            `Created tmux session '${sessionName}'`,
                          ),
                    ),
                  ),
                  (error) =>
                    logger
                      .warn(
                        `Failed to create tmux session: ${toWctError(error).message}`,
                      )
                      .pipe(Effect.as(null)),
                ),
              ),
            )
        : Effect.succeed(null),
      ideCommand && !noIde
        ? logger
            .info("Opening IDE...")
            .pipe(
              Effect.andThen(
                Effect.catch(
                  IdeService.use((service) =>
                    service.openIDE(ideCommand, env),
                  ).pipe(Effect.tap(() => logger.success("IDE opened"))),
                  (error) =>
                    logger.warn(
                      `Failed to open IDE: ${toWctError(error).message}`,
                    ),
                ),
              ),
            )
        : Effect.void,
    ]);

    return {
      tmuxSessionStarted: tmuxResult !== null,
    };
  });
}
```

Keep `maybeAttachSession(...)` exported and unchanged.

- [ ] **Step 4: Move CLI attach behavior into `open.ts`**

Update `src/commands/open.ts` to remove `noAttach` from shared open types and use the returned startup bit:

```ts
export interface OpenOptions {
  branch: string;
  existing: boolean;
  base?: string;
  cwd?: string;
  noIde?: boolean;
  prompt?: string;
  profile?: string;
}

export interface OpenRequest {
  branch?: string;
  existing?: boolean;
  base?: string;
  cwd?: string;
  noIde?: boolean;
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
  tmuxSessionStarted: boolean;
  warnings: string[];
}
```

In `openWorktree(...)`, consume the new launch result:

```ts
const launchResult = yield* launchSessionAndIde({
  sessionName,
  workingDir: worktreePath,
  tmuxConfig: resolved.tmux,
  env,
  ideCommand: resolved.ide?.command,
  noIde,
});

return {
  worktreePath,
  branch,
  sessionName,
  projectName: config.project_name,
  created: worktreeResult._tag !== "AlreadyExists",
  tmuxSessionStarted: launchResult.tmuxSessionStarted,
  warnings,
};
```

Then update `openCommand(...)` so it owns attach behavior:

```ts
export interface OpenCommandOptions extends OpenOptions {
  noAttach?: boolean;
}

export function openCommand(
  options: OpenCommandOptions,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const result = yield* openWorktree(options);

    if (result.tmuxSessionStarted) {
      yield* maybeAttachSession(result.sessionName, options.noAttach);
    }
  });
}
```

Make sure every `resolveOpenOptions(...)` return shape and test fixture expectation drops `noAttach`.

- [ ] **Step 5: Stop and let repo hooks run**

Verification mechanism for this repo:

```bash
# No manual test command.
# Stop the worker and let hooks run lint + tests.
```

Expected after implementation:

- command-layer tests pass
- no type errors remain around `noAttach` in shared open types
- CLI `openCommand(...)` only calls `maybeAttachSession(...)` when `tmuxSessionStarted` is true

- [ ] **Step 6: Commit**

```bash
git add src/commands/open.ts src/commands/session.ts tests/open.test.ts
git commit -m "refactor(open): move attach policy to command layer"
```

### Task 2: Update the TUI open flow to use the new shared boundary

**Files:**
- Modify: `tests/tui/modal-actions.test.ts`
- Modify: `src/tui/hooks/useModalActions.ts`

- [ ] **Step 1: Write the failing TUI tests**

Update `tests/tui/modal-actions.test.ts` so the mocked resolved options and expectations no longer include `noAttach`, and add a regression test for tmux-less configs:

```ts
test("runs open in process, refreshes, and clears pending on success", async () => {
  (runTuiSilentPromise as Mock)
    .mockResolvedValueOnce({
      branch: "feat",
      existing: false,
      base: "main",
      cwd: "/repo",
      noIde: true,
      profile: "dev",
      prompt: "ship it",
    })
    .mockResolvedValueOnce({
      worktreePath: "/repo/feat",
      branch: "feat",
      sessionName: "feat",
      projectName: "proj",
      created: true,
      tmuxSessionStarted: true,
      warnings: [],
    });

  const deps = makeDeps({
    openModalRepoProject: "proj",
    openModalRepoPath: "/repo",
    refreshAll: vi.fn().mockResolvedValue(undefined),
  });

  createHandleOpen(deps)({
    branch: "feat",
    base: "main",
    pr: "",
    profile: "dev",
    prompt: "ship it",
    existing: false,
    noIde: true,
    noAttach: true,
  });

  expect(resolveOpenOptions).toHaveBeenCalledWith({
    branch: "feat",
    base: "main",
    cwd: "/repo",
    pr: "",
    profile: "dev",
    prompt: "ship it",
    existing: false,
    noIde: true,
  });
});

test("skips client discovery when open did not start tmux", async () => {
  const discoverClient = vi.fn();

  (runTuiSilentPromise as Mock)
    .mockResolvedValueOnce({
      branch: "feat",
      existing: false,
      cwd: "/repo",
    })
    .mockResolvedValueOnce({
      worktreePath: "/repo/feat",
      branch: "feat",
      sessionName: "feat",
      projectName: "proj",
      created: true,
      tmuxSessionStarted: false,
      warnings: [],
    });

  const deps = makeDeps({
    openModalRepoProject: "proj",
    openModalRepoPath: "/repo",
    discoverClient,
    refreshAll: vi.fn().mockResolvedValue(undefined),
  });

  createHandleOpen(deps)({
    branch: "feat",
    base: undefined,
    pr: undefined,
    profile: undefined,
    prompt: undefined,
    existing: false,
    noIde: false,
    noAttach: false,
  });

  await vi.waitFor(() => {
    expect(deps.refreshAll).toHaveBeenCalled();
  });
  expect(discoverClient).not.toHaveBeenCalled();
  expect(deps.showActionError).not.toHaveBeenCalledWith(
    expect.stringContaining("tmux client"),
  );
});
```

Update the existing warning-path mocks in the same file so each successful open result includes `tmuxSessionStarted: true`.

- [ ] **Step 2: Stop and let repo hooks run**

Verification mechanism for this repo:

```bash
# No manual test command.
# Stop the worker and let hooks run lint + tests.
```

Expected before implementation: hook-driven tests fail because:

- `resolveOpenOptions(...)` is still called with `noAttach`
- TUI still tries handoff whenever modal `noAttach` is false, even if no tmux session was started

- [ ] **Step 3: Implement the TUI boundary change**

Update `src/tui/hooks/useModalActions.ts` so the shared request drops `noAttach`, and the handoff guard uses the new open result bit:

```ts
const resolved = await runTuiSilentPromise(
  resolveOpenOptions({
    branch: requestedBranch,
    base: opts.base,
    cwd: deps.openModalRepoPath || undefined,
    pr: opts.pr,
    profile: opts.profile,
    prompt: opts.prompt,
    existing: opts.existing,
    noIde: opts.noIde,
  }),
);

const result = await runTuiSilentPromise(openWorktree(resolved));

if (result.warnings.length > 0) {
  appendWarning(result.warnings.join("\n"));
}

if (!opts.noAttach && result.tmuxSessionStarted) {
  const liveClient = await deps.discoverClient();
  if (liveClient.type === "single") {
    const switched = await deps.switchSession(
      result.sessionName,
      liveClient.client,
    );
    if (!switched) {
      appendWarning(
        `Started session '${result.sessionName}', but failed to switch client`,
      );
    }
  } else if (liveClient.type === "none") {
    appendWarning("No tmux client found — start tmux in the other pane");
  } else if (liveClient.type === "error") {
    appendWarning(
      `Opened session '${result.sessionName}' but failed to query tmux clients to switch`,
    );
  } else if (liveClient.type === "multiple") {
    appendWarning(
      "Cannot switch tmux client after open because multiple tmux clients are attached",
    );
  }
}
```

Do not change the modal result type. `opts.noAttach` remains a TUI-only client-handoff preference.

- [ ] **Step 4: Stop and let repo hooks run**

Verification mechanism for this repo:

```bash
# No manual test command.
# Stop the worker and let hooks run lint + tests.
```

Expected after implementation:

- TUI tests pass with the updated shared request shape
- attach warning paths still work when `tmuxSessionStarted` is true
- no handoff attempt happens when `tmuxSessionStarted` is false

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/useModalActions.ts tests/tui/modal-actions.test.ts
git commit -m "fix(tui): gate open handoff on tmux startup"
```

### Task 3: Final review and branch handoff

**Files:**
- Modify: none expected
- Review: `src/commands/open.ts`
- Review: `src/commands/session.ts`
- Review: `src/tui/hooks/useModalActions.ts`
- Review: `tests/open.test.ts`
- Review: `tests/tui/modal-actions.test.ts`

- [ ] **Step 1: Review the final boundary against the spec**

Check these exact invariants in the diff:

```text
1. `OpenRequest` and `OpenOptions` in src/commands/open.ts do not contain `noAttach`.
2. `OpenWorktreeResult` contains `tmuxSessionStarted: boolean`.
3. `launchSessionAndIde(...)` in src/commands/session.ts does not call `maybeAttachSession(...)`.
4. `openCommand(...)` is the only open-path caller of `maybeAttachSession(...)`.
5. `createHandleOpen(...)` calls `resolveOpenOptions(...)` without `noAttach`.
6. `createHandleOpen(...)` only calls `discoverClient()` when `!opts.noAttach && result.tmuxSessionStarted`.
```

- [ ] **Step 2: Stop and let repo hooks run one final time**

Verification mechanism for this repo:

```bash
# No manual test command.
# Stop the worker and let hooks run lint + tests.
```

Expected:

- repo hooks complete without waking the worker on failure
- no remaining test references expect shared `noAttach`

- [ ] **Step 3: Commit any final cleanup**

If the review changed code:

```bash
git add src/commands/open.ts src/commands/session.ts src/tui/hooks/useModalActions.ts tests/open.test.ts tests/tui/modal-actions.test.ts
git commit -m "chore: finalize open attach boundary refactor"
```

If no files changed, skip this step.

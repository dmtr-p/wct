# TUI Open In-Process Design

## Goal

Replace the TUI `open` action's `Bun.spawn(["wct", ...])` subprocess handoff with an in-process Effect call, while preserving the existing `wct open` workflow as the single source of truth.

The TUI should behave like the existing `up` action:

- execute the workflow in-process through `tuiRuntime.runPromise(...)`
- refresh TUI state on success
- show only an error banner on failure
- avoid streaming CLI-oriented logs into the TUI

## Current State

The CLI `open` implementation in `src/commands/open.ts` owns the full workflow:

- validate repository context
- load config and resolve profile
- register the repo in the registry
- validate option combinations and base branch existence
- create the worktree
- sync VS Code workspace state when configured
- copy configured files
- run setup commands
- launch tmux and IDE

The TUI does not call that logic directly. Instead, `src/tui/hooks/useModalActions.ts` assembles CLI arguments and runs `wct open ...` as a child process with output ignored.

That creates two problems:

- the TUI cannot reuse the command's behavior except through a shell boundary
- future changes to `open` behavior are harder to keep consistent between CLI and TUI

## Chosen Approach

Extract the current `openCommand(...)` workflow into a shared Effect operation and let both the CLI and TUI call that operation directly.

This is intentionally the same pattern already used by the TUI `up` path, which calls `startWorktreeSession(...)` in-process instead of shelling out to `wct up`.

The shared operation will stay in `src/commands/open.ts` for this refactor to minimize churn. A larger architectural move into a separate service module is not needed for this change.

## Design

### Shared operation

Add a new shared Effect entry point in `src/commands/open.ts`:

- `openWorktree(options: OpenOptions): Effect.Effect<OpenWorktreeResult, WctError, WctServices>`

This operation will contain the current orchestration logic from `openCommand(...)`, but it will not emit CLI logging.

It remains responsible for:

- repository validation
- config loading and profile resolution
- registry auto-registration
- option validation
- worktree path and session name resolution
- worktree creation
- optional VS Code workspace sync
- optional copy steps
- optional setup steps
- launching tmux and IDE

### Result type

Return a structured result instead of `void` so callers can react without re-deriving state.

The result should include:

- `worktreePath`
- `branch`
- `sessionName`
- `projectName`
- whether the worktree was newly created or already existed
- enough summary information for the CLI to print current copy/setup messages without re-running logic

The exact shape can stay small. The important part is that the boundary is reusable and not CLI-output-oriented.

### CLI wrapper

Keep `openCommand(...)` as a thin adapter that:

- calls `openWorktree(...)`
- emits the existing informational and success/warn logs based on the returned result

This preserves current CLI behavior while removing workflow duplication risk.

### TUI integration

Update `src/tui/hooks/useModalActions.ts` so `createHandleOpen(...)`:

- stops building a `wct open ...` argv list
- stops calling `Bun.spawn(...)`
- calls `tuiRuntime.runPromise(openWorktree(...))`

The TUI should keep ownership of:

- pending action state
- immediate mode transition back to navigation
- refresh timing
- error banner rendering

Success path:

- call `refreshAll()`
- clear pending action

Failure path:

- call `showActionError(toWctError(error).message)`
- clear pending action

The TUI should not display CLI progress logs or success messages.

## Error Handling

The shared operation should continue to fail with `WctError`.

Caller behavior:

- CLI: convert the result into the existing log output and let command-level error handling render failures as it does today
- TUI: catch the failure, show only the final error message, and refresh only when needed for consistency

No new TUI-specific error type is needed.

## File Changes

Expected files:

- `src/commands/open.ts`
  Extract shared workflow and slim down `openCommand(...)`.
- `src/tui/hooks/useModalActions.ts`
  Replace subprocess spawning with direct in-process execution.

No command-line UX or TUI component structure changes are required beyond the action handler update.

## Testing And Verification

This change should preserve behavior, so the main verification focus is regression safety:

- TUI open still creates or reuses the worktree correctly
- setup/copy/tmux/IDE behavior still matches CLI open semantics
- TUI open refreshes the tree after success
- TUI open shows only an error banner on failure
- CLI open output remains intact

Project instructions say not to run tests or lint manually in-session; rely on the repo hooks for formatting, linting, and tests.

## Risks

The main risk is accidentally mixing CLI presentation concerns into the shared operation boundary. If logging remains embedded in the extracted workflow, the TUI will inherit behavior it does not want.

The second risk is making the result type too detailed. The shared result should expose workflow outcomes, not become a second logging protocol.

## Non-Goals

- moving the open workflow into a new service module
- changing CLI option semantics
- redesigning TUI open UX
- changing `up`/`down`/`close` flows as part of this refactor

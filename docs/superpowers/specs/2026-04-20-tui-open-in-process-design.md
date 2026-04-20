# TUI Open In-Process Design

## Goal

Replace the TUI `open` action's `Bun.spawn(["wct", ...])` subprocess handoff with an in-process Effect call, while preserving the existing `wct open` workflow as the single source of truth.

The TUI should behave like the existing `up` action:

- execute the workflow in-process through `tuiRuntime.runPromise(...)`
- refresh TUI state on success
- show only an error banner on failure
- avoid rendering CLI-oriented logs in the TUI

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

PR-specific preprocessing does not live with that workflow today. It happens earlier in `src/cli/root-command.ts` and includes:

- validating `--pr` input
- checking whether `gh` is installed
- resolving the PR to a head branch
- detecting or adding a fork remote
- fetching the remote branch
- probing whether a local branch already exists

The TUI does not call any of this logic directly. Instead, `src/tui/hooks/useModalActions.ts` assembles CLI arguments and runs `wct open ...` as a child process with output ignored.

That creates three problems:

- the TUI cannot reuse the command's behavior except through a shell boundary
- PR-based open behavior is only reusable through the CLI root command
- future changes to `open` behavior are harder to keep consistent between CLI and TUI

## Chosen Approach

Extract the current `openCommand(...)` workflow into a shared Effect operation and add a second shared preprocessing step for PR-based opens. Both the CLI and TUI will call those operations directly.

This is intentionally the same pattern already used by the TUI `up` path, which calls `startWorktreeSession(...)` in-process instead of shelling out to `wct up`. `startWorktreeSession(...)` in `src/commands/worktree-session.ts` is the concrete template being mirrored: a shared command-level Effect operation consumed directly by the TUI.

The shared operations will stay in `src/commands/open.ts` for this refactor to minimize churn. A larger architectural move into a separate service module is not needed for this change.

## Design

### Shared operations

Add two shared Effect entry points in `src/commands/open.ts`:

- `resolveOpenOptions(input: OpenRequest): Effect.Effect<OpenOptions, WctError, WctServices>`
- `openWorktree(options: OpenOptions): Effect.Effect<OpenWorktreeResult, WctError, WctServices>`

`resolveOpenOptions(...)` will own the PR-specific preprocessing that currently lives in `src/cli/root-command.ts`:

- branch/`--pr` mutual exclusion rules
- `--pr` plus `--base` validation
- PR argument parsing
- `gh` availability checks
- PR resolution via `GitHubService`
- fork remote detection and creation when needed
- remote branch fetch
- local branch existence probing
- translation into `OpenOptions`

This keeps `openWorktree(...)` focused on the actual open workflow after branch resolution is complete.

`openWorktree(...)` will contain the current orchestration logic from `openCommand(...)` and will continue to emit progress logging through the existing `logger.*` helpers.

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

Return a small structured result instead of `void` so callers can react without re-deriving state.

The result should include:

- `worktreePath`
- `branch`
- `sessionName`
- `projectName`
- `created: boolean`

Copy and setup details should not be surfaced as part of the result contract. Those remain presentation concerns handled by the shared logger output during execution.

### CLI wrapper

Keep `openCommand(...)` as a thin adapter that:

- calls `resolveOpenOptions(...)`
- calls `openWorktree(...)`

The CLI root command should also stop duplicating PR-resolution logic inline and instead delegate to `resolveOpenOptions(...)`.

This preserves current CLI behavior while removing workflow duplication risk.

### Logging strategy

The shared `openWorktree(...)` operation should keep the existing `logger.*` calls in place.

That is the correct boundary for the current workflow because copy/setup progress output is streamed and ordered. Reconstructing that from a result object would either lose fidelity or create an overly detailed result type that acts as a hidden logging protocol.

TUI behavior should be achieved by silencing the logger's underlying `Console` dependency for this execution path rather than stripping logging from the shared operation.

Because `src/utils/logger.ts` is already a thin wrapper over Effect `Console`, the TUI can provide a silent console/logger layer when running `resolveOpenOptions(...)` and `openWorktree(...)`.

### TUI integration

Update `src/tui/hooks/useModalActions.ts` so `createHandleOpen(...)`:

- stops building a `wct open ...` argv list for subprocess execution
- stops calling `Bun.spawn(...)`
- calls `resolveOpenOptions(...)`
- forces `noAttach: true` on the resolved options before calling `openWorktree(...)`
- calls both operations through `tuiRuntime.runPromise(...)` with a silent console/logger layer

The TUI should keep ownership of:

- pending action state
- immediate mode transition back to navigation
- refresh timing
- error banner rendering

For tmux behavior, the TUI must remain in control of the current client. It should not allow `openWorktree(...)` to attach or switch away from the TUI's active session. For this refactor, the TUI path will always force `noAttach: true`, even if the modal option exists in the CLI surface area.

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

- CLI: let shared logger output render progress as it does today, and let command-level error handling render failures
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

The main risk is leaving PR resolution split across multiple layers. If PR preprocessing stays in the CLI root command, the TUI refactor will silently lose `--pr` support.

The second risk is tmux client handoff. If the TUI path allows `launchSessionAndIde(...)` to attach or switch the tmux client, the in-process flow may steal focus from the TUI itself.

The third risk is making the result type too detailed. The shared result should expose workflow outcomes, not become a second logging protocol.

## Non-Goals

- moving the open workflow into a new service module
- changing CLI option semantics
- redesigning TUI open UX
- changing `up`/`down`/`close` flows as part of this refactor

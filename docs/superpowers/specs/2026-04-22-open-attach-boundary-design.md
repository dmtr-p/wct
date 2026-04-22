# Open Attach Boundary Design

## Goal

Remove CLI-specific tmux attach and switch behavior from the shared `openWorktree(...)` flow so the TUI no longer needs to pass `noAttach: true` just to protect its own terminal.

The refactor should stay small:

- keep worktree creation, setup, tmux session creation, and IDE launch inside `openWorktree(...)`
- move only the same-process attach and switch behavior out to the CLI command layer
- let the TUI keep its separate post-open tmux client handoff behavior
- preserve current `wct open` CLI behavior, including `--no-attach`

## Current State

The `open` workflow currently mixes two different responsibilities:

- shared environment setup that both CLI and TUI need
- CLI-specific attach behavior that only makes sense when `wct open` owns the current terminal

Today:

- `src/commands/open.ts` accepts `noAttach` in `OpenRequest` and `OpenOptions`
- `openWorktree(...)` passes that flag into `launchSessionAndIde(...)`
- `src/commands/session.ts` calls `maybeAttachSession(...)` inside `launchSessionAndIde(...)`
- `src/tui/hooks/useModalActions.ts` works around that by forcing `noAttach: true`

That boundary is awkward for two reasons:

- the TUI has to know about a CLI-only control-flow concern
- the shared operation cannot tell callers whether tmux startup actually happened, so callers can attempt handoff for tmux-less configs

There is already a better pattern in the codebase. `src/commands/up.ts` calls `startWorktreeSession(...)`, inspects the result, and only then calls `maybeAttachSession(...)` from the command layer. `open` should follow that same structure.

## Chosen Approach

Extract only the attach policy from the shared open flow.

After this refactor:

- `openWorktree(...)` still creates the worktree and starts tmux and IDE when configured
- `launchSessionAndIde(...)` no longer attaches or switches the current process
- `openCommand(...)` becomes responsible for calling `maybeAttachSession(...)` after a successful open, mirroring `upCommand(...)`
- the TUI open path stops passing `noAttach` into `resolveOpenOptions(...)`
- the TUI modal `No attach` toggle continues to mean only "do not switch the detected tmux client after open"

This keeps the change small and aligns `open` with an existing command pattern rather than introducing a new abstraction.

## Design

### Shared open result

`OpenWorktreeResult` should expose whether tmux startup actually succeeded.

The smallest safe addition is:

- `tmuxSessionStarted: boolean`

Semantics:

- `true` when tmux configuration existed and session creation succeeded or the session already existed
- `false` when no tmux configuration exists
- `false` when tmux session creation was attempted but failed

This field is enough for both callers:

- CLI only calls `maybeAttachSession(...)` when `tmuxSessionStarted` is `true`
- TUI only attempts client discovery and switching when `tmuxSessionStarted` is `true` and the modal `No attach` toggle is off

No broader result-type redesign is needed for this refactor.

### `open.ts`

Update `src/commands/open.ts` so:

- `OpenRequest` no longer includes `noAttach`
- `OpenOptions` no longer includes `noAttach`
- `resolveOpenOptions(...)` stops threading `noAttach`
- `openWorktree(...)` stops accepting or forwarding `noAttach`
- `openWorktree(...)` returns `tmuxSessionStarted`
- `openCommand(...)` calls `maybeAttachSession(result.sessionName, options.noAttach)` only when `result.tmuxSessionStarted` is `true`

`openCommand(...)` should remain the CLI adapter for the shared workflow. The CLI root command still passes `noAttach` into `openCommand(...)`; only the consumption point changes.

### `session.ts`

Update `src/commands/session.ts` so:

- `launchSessionAndIde(...)` no longer accepts `noAttach`
- `launchSessionAndIde(...)` no longer calls `maybeAttachSession(...)`
- `maybeAttachSession(...)` stays exported for CLI command use

`launchSessionAndIde(...)` continues to:

- create tmux session when configured
- open IDE when configured
- log non-fatal warnings for tmux or IDE startup failures

It becomes a pure "start resources" helper instead of a "start and maybe steal the terminal" helper.

### TUI open flow

Update `src/tui/hooks/useModalActions.ts` so:

- `resolveOpenOptions(...)` is called without `noAttach`
- the hardcoded `noAttach: true` override is removed
- post-open tmux client handoff only runs when:
  - modal `opts.noAttach === false`
  - `result.tmuxSessionStarted === true`

If tmux was not started, the TUI should skip client discovery entirely and should not show attach or switch warnings.

The TUI keeps ownership of:

- pending-action state
- refresh timing
- warning aggregation
- client discovery and client switching

## Behavior

### CLI behavior

User-facing CLI behavior should stay the same:

- `wct open` still creates the worktree and starts tmux and IDE
- `--no-attach` still suppresses same-process tmux attach behavior
- when tmux session creation succeeds, CLI still auto-switches or attaches as it does today

The only behavior change is correctness:

- CLI no longer attempts attach behavior when no tmux session was started

### TUI behavior

The TUI should stop depending on CLI attach flags.

After the refactor:

- the TUI runs the shared open workflow with no attach override
- if tmux was not started, it does nothing related to client handoff
- if tmux was started and modal `No attach` is off, it uses existing client discovery and switching behavior
- if tmux was started and modal `No attach` is on, it stays in the TUI

This preserves the in-process TUI safety boundary and removes the leaked CLI concern from the TUI call site.

## Error Handling

The refactor does not change the existing error model:

- shared workflow failures still surface as `WctError`
- tmux and IDE startup failures inside `launchSessionAndIde(...)` remain non-fatal warnings
- CLI attach failures remain command-layer warnings from `maybeAttachSession(...)`
- TUI client handoff failures remain TUI warning banners

The important boundary change is that attach and handoff are only attempted when tmux startup actually produced a session to target.

## File Changes

Expected files:

- `src/commands/open.ts`
- `src/commands/session.ts`
- `src/tui/hooks/useModalActions.ts`
- `src/cli/root-command.ts`
  - likely no behavioral change, but it remains part of the wiring path
- tests covering `open` command behavior and TUI modal actions

`src/commands/up.ts` should not need behavior changes. It is only the reference pattern for the refactor.

## Testing And Verification

Verification should focus on boundary behavior:

- CLI `open` still auto-attaches when tmux session creation succeeds and `--no-attach` is not set
- CLI `open --no-attach` still suppresses attach
- CLI `open` does not attempt attach when tmux config is absent or tmux startup fails
- TUI open does not pass any attach flag into shared open option resolution
- TUI open does not attempt client discovery or switch when tmux was not started
- TUI open still attempts client switch when tmux was started and modal `No attach` is off

Project instructions say not to run tests or lint manually in-session; rely on the repo hooks for formatting, linting, and tests.

## Risks

The main risk is returning too little tmux status from `openWorktree(...)`. If the result does not say whether a session exists, callers will continue making attach decisions on incomplete information.

The second risk is unintentionally changing CLI behavior by moving `maybeAttachSession(...)` to the wrong layer. The command should still own it directly, as `upCommand(...)` already does.

The third risk is leaving stale `noAttach` threading in `OpenRequest`, `OpenOptions`, or TUI call sites, which would preserve the wrong ownership boundary even if behavior still works.

## Non-Goals

- redesigning how tmux session creation works
- replacing `tmuxSessionStarted: boolean` with a larger operation-result model
- changing TUI client discovery semantics
- merging CLI attach behavior and TUI client handoff into a single abstraction
- broader refactors to `worktree-session.ts` or `up.ts`

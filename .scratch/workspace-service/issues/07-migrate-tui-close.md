Status: done

# Migrate TUI close to WorkspaceService

## Parent

.scratch/workspace-service/PRD.md

## What to build

Update TUI close and force-close paths to use Workspace `close`. The TUI should preserve active-client safety checks before close, pending state, force confirmation mode, and refresh behavior.

## Acceptance criteria

- [x] TUI close calls Workspace `close`.
- [x] TUI force-close calls Workspace `close` with force.
- [x] Active-client move/detach safety remains outside Workspace and runs before close.
- [x] A blocked-by-changes result moves the TUI into force-confirm mode.
- [x] Tmux kill failure from Workspace is surfaced as an action error.
- [x] TUI refresh behavior after close remains materially compatible.
- [x] TUI pending state is cleared after success, blocked result, or failure.
- [x] TUI tests cover successful close, blocked close, force close, active-client safety failure, tmux kill failure, refresh behavior, and pending-state cleanup.

## Blocked by

- .scratch/workspace-service/issues/06-add-workspace-close-lifecycle.md

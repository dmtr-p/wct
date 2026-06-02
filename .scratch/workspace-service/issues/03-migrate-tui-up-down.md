Status: done

# Migrate TUI up and down to WorkspaceService

## Parent

.scratch/workspace-service/PRD.md

## What to build

Update TUI start and stop actions to use the Workspace lifecycle service for `up` and `down`. TUI interaction policy remains at the TUI seam, including active-client safety checks before stopping a session.

Absent tmux sessions during down should no longer be shown through the TUI action-error lane.

## Acceptance criteria

- [x] TUI up/start actions call Workspace `up`.
- [x] TUI down/stop actions call Workspace `down`.
- [x] TUI active-client move/detach safety remains outside Workspace.
- [x] TUI no longer reports an absent tmux session during down as an action error.
- [x] TUI pending state is cleared after success, informational no-op, or failure.
- [x] TUI refresh behavior after up/down remains materially compatible.
- [x] TUI tests cover successful up, successful down, absent-session down, kill failure, and pending-state cleanup.

## Blocked by

- .scratch/workspace-service/issues/02-introduce-workspace-service-up-down.md

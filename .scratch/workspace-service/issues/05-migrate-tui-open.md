Status: ready-for-agent

# Migrate TUI open to WorkspaceService

## Parent

.scratch/workspace-service/PRD.md

## What to build

Update the TUI open action to call Workspace `open` for branch and PR opens. The TUI should keep modal state, pending state, auto-switch behavior, project registration, and refresh behavior at the TUI seam.

The TUI must not call copy/setup or PR resolution directly.

## Acceptance criteria

- [ ] TUI open action calls Workspace `open`.
- [ ] TUI branch and PR opens both use the Workspace lifecycle path.
- [ ] TUI open performs project registration after successful Workspace open.
- [ ] TUI open auto-registration does not rename existing registry rows.
- [ ] TUI open no longer relies on silent Console suppression for Workspace lifecycle output.
- [ ] TUI open preserves auto-switch behavior after tmux session creation.
- [ ] TUI open preserves warning/action-error surfacing for non-fatal Workspace warnings.
- [ ] TUI open refreshes after successful open and handles refresh failure as a warning.
- [ ] TUI pending state is cleared after success or failure.
- [ ] TUI tests cover successful branch open, PR open wiring, registration after success, no registration after fatal failure, warning surfacing, auto-switch behavior, refresh failure handling, and pending-state cleanup.

## Blocked by

- .scratch/workspace-service/issues/04-add-workspace-open-lifecycle.md


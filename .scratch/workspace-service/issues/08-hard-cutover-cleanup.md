Status: ready-for-agent

# Hard cutover cleanup and compatibility sweep

## Parent

.scratch/workspace-service/PRD.md

## What to build

Complete the hard cutover to Workspace by removing old lifecycle modules and command-layer helpers, updating imports and tests, and verifying there is only one lifecycle interface.

This slice should leave lookup/navigation commands such as switch and cd outside Workspace.

## Acceptance criteria

- [ ] Old command-layer lifecycle module exports are deleted or removed from public use.
- [ ] Old command-layer target-resolution helper is deleted after migration.
- [ ] Commands and TUI actions no longer import deleted lifecycle helpers.
- [ ] `switch` and `cd` remain outside Workspace.
- [ ] `formatSessionName` remains in the tmux module.
- [ ] Service bundles provide Workspace for CLI and TUI runtimes.
- [ ] Tests are renamed or reorganized around Workspace behavior where appropriate.
- [ ] No duplicate lifecycle implementation remains.
- [ ] Existing command behavior is materially preserved, except for approved changes around absent-session info, stricter close kill failure, and registration forceRename semantics.

## Blocked by

- .scratch/workspace-service/issues/03-migrate-tui-up-down.md
- .scratch/workspace-service/issues/05-migrate-tui-open.md
- .scratch/workspace-service/issues/07-migrate-tui-close.md


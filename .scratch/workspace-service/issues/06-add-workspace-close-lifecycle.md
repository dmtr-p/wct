Status: done

# Add WorkspaceService close lifecycle

## Parent

.scratch/workspace-service/PRD.md

## What to build

Move single-target close lifecycle into Workspace. Closing a Workspace should resolve the target, derive the current session name, kill the tmux session first, then remove the worktree.

CLI batching, prompts, and force confirmation stay outside Workspace.

## Acceptance criteria

- [x] Workspace `close` accepts a single target plus optional force flag.
- [x] Workspace `close` supports target resolution by branch/path/current context.
- [x] Session naming preserves current basename-based behavior.
- [x] Close kills the tmux session before attempting worktree removal.
- [x] If the tmux session is absent, close treats that as informational and continues to removal.
- [x] If an existing tmux session kill fails, close fails and does not remove the worktree.
- [x] If removal is blocked by changes, close returns a structured blocked result.
- [x] Force close removes a dirty worktree when the low-level adapter allows it.
- [x] CLI close loops over branch arguments and keeps prompt/batching policy outside Workspace.
- [x] CLI close uses Workspace for actual lifecycle mutation.
- [x] CLI close JSON emits final close results only.
- [x] Tests cover absent session, kill-first ordering, kill failure preventing removal, blocked-by-changes result, force removal, CLI loop behavior, and prompt policy staying outside Workspace.

## Blocked by

- .scratch/workspace-service/issues/02-introduce-workspace-service-up-down.md

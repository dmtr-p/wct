# Remove Hooks and Notifications

**Date:** 2026-04-09
**Status:** Approved

## Summary

Remove all hooks and notification functionality from wct. The feature (Claude Code hook integration that queues notifications into a SQLite table and displays them in the TUI) is not working and adds unnecessary complexity. This is a full surgical removal with zero dead code left behind.

## Scope

### Files to delete (6)

| File | Purpose |
|------|---------|
| `src/commands/hooks.ts` | `wct hooks` command |
| `src/commands/notify.ts` | `wct notify` command |
| `src/services/hooks-service.ts` | Builds/installs Claude Code hook config |
| `src/services/queue-storage.ts` | SQLite-backed notification queue service |
| `src/tui/hooks/useQueue.ts` | React hook for fetching queue items |
| `tests/notify.test.ts` | Notify command tests |

### Files to edit (12)

**CLI layer:**
- `src/cli/root-command.ts` — Remove `hooksCliCommand`, `notifyCliCommand`, their imports, and entries in `withSubcommands`.
- `src/cli/completions.ts` — Remove `notifyCommandDef` import and entry.

**Service layer:**
- `src/effect/services.ts` — Remove `HooksService`, `liveHooksService`, `QueueStorage`, `liveQueueStorage`, `QueueStorageService` from imports, type unions, and live layer.
- `src/tui/runtime.ts` — Remove `QueueStorage` and `liveQueueStorage` from imports and TUI layer.

**Commands:**
- `src/commands/close.ts` — Remove `QueueStorage` import and the queue cleanup block after tmux session kill. Keep surrounding kill/log logic.
- `src/commands/down.ts` — Same: remove `QueueStorage` import and queue cleanup block.

**TUI:**
- `src/tui/App.tsx` — Remove `useQueue` import/call, `queueItems` from props/state, notification detail row building, `queueItems` prop on `TreeView`.
- `src/tui/components/TreeView.tsx` — Remove `QueueItem` import, `queueItems` prop, `notifCounts` computation, `notifications` prop on `WorktreeItem`.
- `src/tui/components/WorktreeItem.tsx` — Remove `notifications` prop and badge rendering.
- `src/tui/components/DetailRow.tsx` — Remove `notification-header` and `notification` cases.
- `src/tui/types.ts` — Remove `"notification-header"` and `"notification"` from detail kind union.

**Tests:**
- `tests/helpers/services.ts` — Remove `HooksService`, `liveHooksService`, `QueueStorage`, `liveQueueStorage`, `QueueStorageService` from imports and test overrides.
- `tests/down.test.ts` — Remove `QueueStorageService`, `liveQueueStorage` imports and `queueOverrides`/`queueStorage` test plumbing.

## Out of scope

- The `~/.wct/wct.db` SQLite database file stays. It is shared with `registry-service.ts` for project storage and will be used for future caching.
- No changes to the config schema (`.wct.yaml`).
- No changes to tmux, IDE, GitHub, or worktree services.

## Testing

Existing tests pass after removing the hooks/queue test infrastructure. The `down.test.ts` tests simplify (no queue mock needed). No new tests required since this is pure removal.

# Remove `wct queue` CLI Subcommand

## Goal

Remove the `wct queue` CLI subcommand. The TUI (`wct tui`) now serves as the primary interface for viewing and interacting with notifications, making the CLI command redundant.

## What Gets Removed

1. **`src/commands/queue.ts`** — command implementation (formatType, formatAge, jumpToItem, queueCommand)
2. **`tests/queue-command.test.ts`** — tests for the queue command
3. **Queue command registration in `src/cli/root-command.ts`** — import, `queueCliCommand` definition, and its inclusion in the root command tree
4. **Queue command definition in `src/cli/completions.ts`** — import and entry in the completions array
5. **`AGENTS.md`** — remove `queue.ts` from the architecture command listing

## What Stays

- `src/services/queue-storage.ts` — still used by notify, TUI, down, close
- `src/commands/notify.ts` — writes notifications to queue
- `src/tui/hooks/useQueue.ts` — TUI reads and displays queue items
- `src/commands/down.ts` / `src/commands/close.ts` — clean up queue entries on teardown
- `tests/queue-service.test.ts`, `tests/notify.test.ts`, `tests/close.test.ts`, `tests/down.test.ts`
- `"queue_error"` in `src/errors.ts` — still used by `queue-storage.ts`

## Verification

- All existing tests pass (except removed `queue-command.test.ts`)
- `biome check` passes
- `wct queue` no longer appears as a subcommand

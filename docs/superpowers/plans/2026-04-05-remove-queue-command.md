# Remove `wct queue` Command — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `wct queue` CLI subcommand while keeping queue-storage service and notification infrastructure intact.

**Architecture:** Delete the command module and its tests, then remove all CLI-surface references from the CLI root and completions. The queue storage service, `notify`, `close`, `down`, and TUI queue hooks remain untouched, so shared queue error handling stays in place.

**Tech Stack:** Effect CLI, TypeScript, Vitest

---

### Task 1: Remove queue command module and tests

**Note:** This task is coupled to Tasks 2 and 3 in practice. Deleting `src/commands/queue.ts` leaves stale imports in the CLI root and completions until those follow-up tasks land, so these tasks should be treated as one logical change for implementation and review.

**Files:**
- Delete: `src/commands/queue.ts`
- Delete: `tests/queue-command.test.ts`

- [ ] **Step 1: Delete the queue command module**

```bash
rm src/commands/queue.ts
```

- [ ] **Step 2: Delete the queue command tests**

```bash
rm tests/queue-command.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add -u src/commands/queue.ts tests/queue-command.test.ts
git commit -m "remove wct queue command module and tests"
```

---

### Task 2: Remove queue from CLI root command

**Files:**
- Modify: `src/cli/root-command.ts`

- [ ] **Step 1: Remove queue import and CLI command definition**

In `src/cli/root-command.ts`, remove the import on line 10:

```typescript
import { queueCommand } from "../commands/queue";
```

Remove the `queueCliCommand` definition (lines 130–153):

```typescript
const queueCliCommand = Command.make(
  "queue",
  {
    jump: optionalStringFlag(
      "jump",
      "Jump to item's tmux session/pane",
      undefined,
      "ID",
    ),
    dismiss: optionalStringFlag(
      "dismiss",
      "Remove item from queue",
      undefined,
      "ID",
    ),
    clear: booleanFlag("clear", "Clear all queue items"),
  },
  ({ jump, dismiss, clear }) =>
    queueCommand({
      jump: optionToUndefined(jump),
      dismiss: optionToUndefined(dismiss),
      clear,
    }),
).pipe(Command.withDescription("Manage the agent notification queue"));
```

Remove `queueCliCommand` from the `withSubcommands` array (line 367):

```typescript
    queueCliCommand,
```

- [ ] **Step 2: Run tests to verify nothing breaks**

```bash
bun run test
```

Expected: All tests pass (queue-command tests already deleted).

- [ ] **Step 3: Commit**

```bash
git add src/cli/root-command.ts
git commit -m "remove queue subcommand from CLI root"
```

---

### Task 3: Remove queue from completions

**Files:**
- Modify: `src/cli/completions.ts`

- [ ] **Step 1: Remove queue command def import and array entry**

In `src/cli/completions.ts`, remove line 12:

```typescript
import { commandDef as queueCommandDef } from "../commands/queue";
```

Remove `queueCommandDef` from the `commandDefs` array (line 28):

```typescript
  queueCommandDef,
```

- [ ] **Step 2: Run tests to verify completions still work**

```bash
bun run test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/cli/completions.ts
git commit -m "remove queue from shell completions"
```

---

### Task 4: Keep `queue_error` error code

**Files:**
- No changes required

- [ ] **Step 1: Confirm `queue_error` is still part of preserved queue infrastructure**

`queue_error` remains valid because `src/services/queue-storage.ts` still uses it, and that service is intentionally kept for `notify`, `close`, `down`, and the TUI queue hooks.

- [ ] **Step 2: Do not modify `src/errors.ts`**

Keeping `queue_error` avoids breaking the preserved queue-storage path and matches the goal of removing only the `wct queue` CLI subcommand.

---

### Task 5: Fix test that references queue subcommand

**Files:**
- Modify: `tests/completions.test.ts`

- [ ] **Step 1: Update the unrecognized flags JSON test**

In `tests/completions.test.ts`, the test at line 137 uses `"queue"` as the subcommand. Replace it with `"list"` (another subcommand that exists and takes flags):

```typescript
  test("emits JSON for unrecognized flags when --json is present", () => {
    const result = runCliProcess(["--json", "list", "--bad-flag"]);
```

Everything else in the test stays the same — it's testing JSON error shape, not queue-specific behavior.

- [ ] **Step 2: Run that specific test to verify**

```bash
bun run test tests/completions.test.ts
```

Expected: All completions tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/completions.test.ts
git commit -m "update CLI error test to use list instead of removed queue command"
```

---

### Task 6: Update CLAUDE.md architecture

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove queue.ts from the architecture file listing**

In `CLAUDE.md`, remove the line:

```
│   ├── queue.ts          # Native Effect implementation of wct queue
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "remove queue command from architecture docs"
```

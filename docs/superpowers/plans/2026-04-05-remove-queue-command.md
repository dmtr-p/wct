# Remove `wct queue` CLI Subcommand — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `wct queue` CLI subcommand, since the TUI now handles notification viewing/interaction.

**Architecture:** Delete `src/commands/queue.ts` and its test file, then remove all references from the CLI root command, completions, and docs.

**Tech Stack:** Effect CLI, TypeScript, Vitest

---

### Task 1: Remove queue command file and test

**Files:**
- Delete: `src/commands/queue.ts`
- Delete: `tests/queue-command.test.ts`

- [ ] **Step 1: Delete the files**

```bash
rm src/commands/queue.ts tests/queue-command.test.ts
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "refactor: remove wct queue command and its tests"
```

### Task 2: Remove queue command from CLI root and completions

**Files:**
- Modify: `src/cli/root-command.ts`
- Modify: `src/cli/completions.ts`

- [ ] **Step 1: Edit `src/cli/root-command.ts`**

Remove the import:
```typescript
import { queueCommand } from "../commands/queue";
```

Remove the entire `queueCliCommand` definition (lines 129–152):
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

Remove `queueCliCommand,` from the subcommands array (~line 365).

- [ ] **Step 2: Edit `src/cli/completions.ts`**

Remove the import:
```typescript
import { commandDef as queueCommandDef } from "../commands/queue";
```

Remove from the COMMANDS array:
```typescript
  queueCommandDef,
```

- [ ] **Step 3: Run tests to verify nothing broke**

```bash
bun run test
```

Expected: All tests pass (queue-command tests no longer exist, everything else green).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove queue command from CLI root and completions"
```

### Task 3: Update documentation

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Edit `AGENTS.md`**

Remove this line from the architecture section:
```
│   ├── queue.ts          # Native Effect implementation of wct queue
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "docs: remove queue command from architecture listing"
```

### Task 4: Final verification

- [ ] **Step 1: Verify no dangling references**

```bash
grep -rn "commands/queue" src/ tests/ --include="*.ts"
```

Expected: No output.

- [ ] **Step 2: Run full test suite**

```bash
bun run test
```

Expected: All tests pass.

- [ ] **Step 3: Run linting**

```bash
bunx biome check --write
```

Expected: Clean.

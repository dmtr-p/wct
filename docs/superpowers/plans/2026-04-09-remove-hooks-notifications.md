# Remove Hooks and Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all hooks and notification functionality from wct — commands, services, TUI rendering, and tests.

**Architecture:** Pure deletion and reference cleanup. Six files are deleted entirely, twelve files are edited to remove imports and usage. No new code is introduced.

**Tech Stack:** Effect v4, React/Ink (TUI), Vitest

---

### Task 1: Delete dedicated files

**Files:**
- Delete: `src/commands/hooks.ts`
- Delete: `src/commands/notify.ts`
- Delete: `src/services/hooks-service.ts`
- Delete: `src/services/queue-storage.ts`
- Delete: `src/tui/hooks/useQueue.ts`
- Delete: `tests/notify.test.ts`

- [ ] **Step 1: Delete the six files**

```bash
rm src/commands/hooks.ts src/commands/notify.ts src/services/hooks-service.ts src/services/queue-storage.ts src/tui/hooks/useQueue.ts tests/notify.test.ts
```

- [ ] **Step 2: Commit**

```bash
git add -u
git commit -m "chore: delete hooks, notify, queue-storage, and useQueue files"
```

---

### Task 2: Remove hooks/notify from CLI layer

**Files:**
- Modify: `src/cli/root-command.ts`
- Modify: `src/cli/completions.ts`

- [ ] **Step 1: Edit `src/cli/root-command.ts`**

Remove the two imports:
```typescript
import { hooksCommand } from "../commands/hooks";
import { notifyCommand } from "../commands/notify";
```

Remove the `hooksCliCommand` definition (lines 103-112):
```typescript
const hooksCliCommand = Command.make(
  "hooks",
  {
    install: booleanFlag(
      "install",
      "Install hooks into .claude/settings.local.json",
    ),
  },
  ({ install }) => hooksCommand({ install }),
).pipe(Command.withDescription("Output or install Claude Code hooks config"));
```

Remove the `notifyCliCommand` definition (lines 128-130):
```typescript
const notifyCliCommand = Command.make("notify", {}, () => notifyCommand()).pipe(
  Command.withDescription("Queue a notification from Claude Code hooks"),
);
```

Remove `hooksCliCommand` and `notifyCliCommand` from the `withSubcommands` array (lines 362, 365).

- [ ] **Step 2: Edit `src/cli/completions.ts`**

Remove lines 7 and 10:
```typescript
import { commandDef as hooksCommandDef } from "../commands/hooks";
import { commandDef as notifyCommandDef } from "../commands/notify";
```

Remove `hooksCommandDef` and `notifyCommandDef` from the `COMMANDS` array (lines 21 and 24).

- [ ] **Step 3: Verify build**

```bash
bun run src/index.ts --help
```

Expected: `hooks` and `notify` no longer appear in the command list.

- [ ] **Step 4: Commit**

```bash
git add src/cli/root-command.ts src/cli/completions.ts
git commit -m "chore: remove hooks and notify CLI commands"
```

---

### Task 3: Remove services from Effect layer

**Files:**
- Modify: `src/effect/services.ts`
- Modify: `src/tui/runtime.ts`

- [ ] **Step 1: Edit `src/effect/services.ts`**

Remove the HooksService import block (lines 9-13):
```typescript
import {
  HooksService,
  type HooksService as HooksServiceApi,
  liveHooksService,
} from "../services/hooks-service";
```

Remove the QueueStorage import block (lines 19-23):
```typescript
import {
  liveQueueStorage,
  QueueStorage,
  type QueueStorageService,
} from "../services/queue-storage";
```

Remove `| HooksServiceApi` from the `WctServices` type union (line 53).

Remove `| QueueStorageService` from the `WctServices` type union (line 55).

Remove `| QueueStorageService` from the `WctRuntimeServices` type union (line 65).

Remove the two `Effect.provideService` calls from `provideWctServices`:
- The `HooksService, liveHooksService` pair (lines 90-91)
- The `QueueStorage, liveQueueStorage` pair (lines 96-97)

After removal, the nested `Effect.provideService` calls should chain the remaining services: GitHubService, IdeService, SetupService, TmuxService, VSCodeWorkspaceService, WorktreeService, RegistryService.

- [ ] **Step 2: Edit `src/tui/runtime.ts`**

Remove line 4:
```typescript
import { liveQueueStorage, QueueStorage } from "../services/queue-storage";
```

Remove from `tuiLayer` (line 19):
```typescript
  Layer.succeed(QueueStorage, liveQueueStorage),
```

- [ ] **Step 3: Verify build**

```bash
bun run src/index.ts --help
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/effect/services.ts src/tui/runtime.ts
git commit -m "chore: remove HooksService and QueueStorage from Effect layer"
```

---

### Task 4: Remove queue cleanup from close and down commands

**Files:**
- Modify: `src/commands/close.ts`
- Modify: `src/commands/down.ts`

- [ ] **Step 1: Edit `src/commands/close.ts`**

Remove the import (line 5):
```typescript
import { QueueStorage } from "../services/queue-storage";
```

Remove the queue cleanup block after the session kill success (lines 144-152):
```typescript
          yield* Effect.catch(
            QueueStorage.use((service) =>
              service.removeItemsBySession(sessionName),
            ),
            (error) =>
              logger.warn(
                `Failed to clean queue entries for session '${sessionName}': ${toWctError(error).message}`,
              ),
          );
```

The `toWctError` import may become unused — check if it's used elsewhere in the file. It is used on line 139 (`toWctError(error).message`), so keep it.

- [ ] **Step 2: Edit `src/commands/down.ts`**

Remove the import (line 4):
```typescript
import { QueueStorage } from "../services/queue-storage";
```

Remove the queue cleanup block (lines 40-46):
```typescript
    yield* Effect.catch(
      QueueStorage.use((service) => service.removeItemsBySession(sessionName)),
      (error) =>
        logger.warn(
          `Failed to clean queue entries for session '${sessionName}': ${toWctError(error).message}`,
        ),
    );
```

Also remove the now-unused `toWctError` import. Check line 3 — `import { commandError, toWctError } from "../errors"` should become `import { commandError } from "../errors"`.

- [ ] **Step 3: Run tests**

```bash
bun run test
```

Expected: all tests pass (the queue-related down tests will be fixed in Task 6).

- [ ] **Step 4: Commit**

```bash
git add src/commands/close.ts src/commands/down.ts
git commit -m "chore: remove queue cleanup from close and down commands"
```

---

### Task 5: Remove notifications from TUI

**Files:**
- Modify: `src/tui/types.ts`
- Modify: `src/tui/components/DetailRow.tsx`
- Modify: `src/tui/components/WorktreeItem.tsx`
- Modify: `src/tui/components/TreeView.tsx`
- Modify: `src/tui/App.tsx`

- [ ] **Step 1: Edit `src/tui/types.ts`**

Remove `"notification-header"` and `"notification"` from the `DetailKind` union (lines 37-38). Result:

```typescript
export type DetailKind =
  | "pr"
  | "check"
  | "pane-header"
  | "pane";
```

- [ ] **Step 2: Edit `src/tui/components/DetailRow.tsx`**

Update the indent logic (line 16) — remove `kind === "notification-header"` from the condition:
```typescript
  const indent =
    kind === "pr" || kind === "pane-header"
      ? "      " // section header: 6 spaces
      : "        "; // section item: 8 spaces
```

Remove the `case "notification-header":` from the switch (it currently falls through to `pane-header`). The `pane-header` case stays. Remove lines 21-22:
```typescript
    case "notification-header":
```

Remove the entire `case "notification":` block (lines 37-46):
```typescript
    case "notification":
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : "red"} bold={isSelected}>
            {prefix}! {label}
          </Text>
          {meta?.paneRef && <Text dimColor> (pane {meta.paneRef})</Text>}
        </Box>
      );
```

- [ ] **Step 3: Edit `src/tui/components/WorktreeItem.tsx`**

Remove the `notifications` prop from the interface (line 9):
```typescript
  notifications: number;
```

Remove `notifications` from the destructured props (line 34).

Update the `hasStats` check (line 82) — remove `|| notifications > 0`:
```typescript
  const hasStats =
    (sync && sync !== "\u2713") || changedFiles > 0;
```

Remove the notification badge rendering block (lines 134-138):
```typescript
          {notifications > 0 ? (
            <Text color="yellow">
              {(sync && sync !== "\u2713") || changedFiles > 0 ? " " : ""}!
              {notifications}
            </Text>
          ) : null}
```

- [ ] **Step 4: Edit `src/tui/components/TreeView.tsx`**

Remove the `QueueItem` import (line 4):
```typescript
import type { QueueItem } from "../../services/queue-storage";
```

Remove `queueItems` from the `Props` interface (line 22):
```typescript
  queueItems: QueueItem[];
```

Remove `queueItems` from the destructured props (line 36).

Remove the entire `notifCounts` useMemo block (lines 51-58):
```typescript
  const notifCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of queueItems) {
      const key = pendingKey(item.project, item.branch);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [queueItems]);
```

Remove `const notifications = notifCounts.get(wtKey) ?? 0;` (line 130).

Update `hasExpandableData` (line 136) — remove `|| notifications > 0`:
```typescript
    const hasExpandableData =
      !!wtPr || (wtPanes && wtPanes.length > 0);
```

Remove `notifications={notifications}` from the `WorktreeItem` call (line 153).

Remove `notifications={0}` from all phantom `WorktreeItem` calls (lines 181, 207).

- [ ] **Step 5: Edit `src/tui/App.tsx`**

Remove the `QueueItem` import (line 6):
```typescript
import type { QueueItem } from "../services/queue-storage";
```

Remove the `useQueue` import (line 12):
```typescript
import { useQueue } from "./hooks/useQueue";
```

Remove `queueItems: QueueItem[]` from `BuildTreeOptions` interface (line 29).

Remove `queueItems` from the `buildTreeItems` destructured parameter (line 39).

Remove the entire notifications block inside `buildTreeItems` (lines 63-85):
```typescript
        // Notifications for this worktree
        const wtNotifs = queueItems.filter(
          (q) => q.branch === wt.branch && q.project === repo.project,
        );
        if (wtNotifs.length > 0) {
          items.push({
            type: "detail",
            repoIndex: ri,
            worktreeIndex: wi,
            detailKind: "notification-header",
            label: `Notifications (${wtNotifs.length})`,
          });
          for (const notif of wtNotifs) {
            items.push({
              type: "detail",
              repoIndex: ri,
              worktreeIndex: wi,
              detailKind: "notification",
              label: notif.message,
              action: () => jumpToPane(notif.pane),
            });
          }
        }
```

Remove the `useQueue` call (line 146):
```typescript
  const { items: queueItems, refresh: refreshQueue } = useQueue();
```

Remove `queueItems` from the `buildTreeItems` call arguments (line 213) and from the useMemo dependency array (line 222).

Remove `refreshQueue()` from the `refreshAll` callback (line 232). The `Promise.all` should become:
```typescript
    await Promise.all([
      refreshRegistry(),
      refreshSessions(),
      discoverClient(),
    ]);
```

Update the `refreshAll` useCallback dependency array (line 236) — remove `refreshQueue`.

Remove `queueItems={queueItems}` from the `<TreeView>` JSX props (line 638).

Update the `navigateTree` header-skip condition (line 350) — remove `notification-header`:
```typescript
          item.detailKind === "pane-header"
```

- [ ] **Step 6: Verify build**

```bash
bun run src/index.ts tui
```

Expected: TUI launches without errors.

- [ ] **Step 7: Commit**

```bash
git add src/tui/types.ts src/tui/components/DetailRow.tsx src/tui/components/WorktreeItem.tsx src/tui/components/TreeView.tsx src/tui/App.tsx
git commit -m "chore: remove notification rendering from TUI"
```

---

### Task 6: Clean up tests

**Files:**
- Modify: `tests/helpers/services.ts`
- Modify: `tests/down.test.ts`

- [ ] **Step 1: Edit `tests/helpers/services.ts`**

Remove the HooksService import block (lines 9-13):
```typescript
import {
  HooksService,
  type HooksService as HooksServiceApi,
  liveHooksService,
} from "../../src/services/hooks-service";
```

Remove the QueueStorage import block (lines 20-23):
```typescript
import {
  liveQueueStorage,
  QueueStorage,
  type QueueStorageService,
} from "../../src/services/queue-storage";
```

Remove from `ServiceOverrides` interface (lines 50, 53):
```typescript
  hooks?: HooksServiceApi;
  queueStorage?: QueueStorageService;
```

Remove the two `Effect.provideService` calls (lines 71-74 and 81-84):
```typescript
  provided = Effect.provideService(
    provided,
    HooksService,
    overrides.hooks ?? liveHooksService,
  );
```
```typescript
  provided = Effect.provideService(
    provided,
    QueueStorage,
    overrides.queueStorage ?? liveQueueStorage,
  );
```

- [ ] **Step 2: Edit `tests/down.test.ts`**

Remove the QueueStorage imports (lines 14-17):
```typescript
import {
  liveQueueStorage,
  type QueueStorageService,
} from "../src/services/queue-storage";
```

Remove `queueStorage?: QueueStorageService` from the `runCommand` overrides type (line 32).

Remove the `queueCalls` variable declaration (line 69) and all assignments to it.

Remove the `queueOverrides` variable and its `beforeEach` setup (lines 63, 79-86):
```typescript
  let queueOverrides: QueueStorageService;
```
```typescript
    queueOverrides = {
      ...liveQueueStorage,
      removeItemsBySession: (session: string) =>
        Effect.sync(() => {
          queueCalls.push(session);
          return 0;
        }),
    };
```

Update the three test cases:

**Test "removes queue items only after a successful kill"** (lines 93-121): This test no longer makes sense — queue cleanup is gone. Remove the entire test.

**Test "does not remove queue items when killSession fails"** (lines 123-137): The queue assertion is gone. Simplify to just verify the command throws on kill failure:
```typescript
  test("fails when killSession throws", async () => {
    tmuxOverrides = {
      ...tmuxOverrides,
      killSession: () => Effect.fail(commandError("tmux_error", "tmux failed")),
    };

    await expect(
      runCommand({
        tmux: tmuxOverrides,
        worktree: worktreeOverrides,
      }),
    ).rejects.toThrow("tmux failed");
  });
```

**Test "warns and succeeds when queue cleanup fails after kill"** (lines 139-163): Remove entirely — there's no queue cleanup to fail.

- [ ] **Step 3: Run tests**

```bash
bun run test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/services.ts tests/down.test.ts
git commit -m "chore: remove hooks and queue-storage from test infrastructure"
```

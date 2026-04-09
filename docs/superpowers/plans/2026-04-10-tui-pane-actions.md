# TUI Pane Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add zoom toggle, kill actions, and zoom indicator for tmux panes in the TUI expanded worktree view.

**Architecture:** Extend `TmuxPaneInfo` with zoom state from tmux, add `zoomPane`/`killPane` operations to the service layer, wire new `z`/`x` keybindings in expanded mode with a confirmation modal for kill, and render a magnifying glass icon on zoomed panes.

**Tech Stack:** Effect, React/Ink, tmux CLI, vitest

---

### Task 1: Add zoom state to TmuxPaneInfo and update parser

**Files:**
- Modify: `src/services/tmux.ts:14-25` (TmuxPaneInfo interface)
- Modify: `src/services/tmux.ts:106-124` (parsePaneListOutput)
- Modify: `src/services/tmux.ts:477-489` (listPanesImpl format string)
- Test: `tests/tmux.test.ts`

- [ ] **Step 1: Write failing tests for updated parsePaneListOutput**

Add to `tests/tmux.test.ts` inside the existing `parsePaneListOutput` describe block:

```typescript
test("parses pane list output with zoom flag", () => {
  const output = "%0\t0\tbash\tshell\t1\n%1\t1\tvim\teditor\t0";
  const panes = parsePaneListOutput(output);
  expect(panes).toHaveLength(2);
  expect(panes[0]).toEqual({
    paneId: "%0",
    paneIndex: 0,
    command: "bash",
    window: "shell",
    zoomed: true,
  });
  expect(panes[1]).toEqual({
    paneId: "%1",
    paneIndex: 1,
    command: "vim",
    window: "editor",
    zoomed: false,
  });
});

test("defaults zoomed to false when flag is missing", () => {
  const output = "%0\t0\tbash\tshell";
  const panes = parsePaneListOutput(output);
  expect(panes[0]).toEqual({
    paneId: "%0",
    paneIndex: 0,
    command: "bash",
    window: "shell",
    zoomed: false,
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — `zoomed` property missing from parsed output.

- [ ] **Step 3: Update TmuxPaneInfo and parsePaneListOutput**

In `src/services/tmux.ts`, add `zoomed` to the interface:

```typescript
export interface TmuxPaneInfo {
  paneId: string;
  paneIndex: number;
  command: string;
  window: string;
  zoomed: boolean;
}
```

Update `parsePaneListOutput` to parse the fifth column:

```typescript
export function parsePaneListOutput(output: string): TmuxPaneInfo[] {
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [pid, pIdx, cmd, win, zoom] = line.split("\t");
      return pid
        ? [
            {
              paneId: pid,
              paneIndex: Number(pIdx),
              command: cmd || "",
              window: win || "",
              zoomed: zoom === "1",
            },
          ]
        : [];
    });
}
```

Update `listPanesImpl` format string to include zoom flag:

```typescript
function listPanesImpl(sessionName: string) {
  return Effect.catch(
    execProcess("tmux", [
      "list-panes",
      "-s",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{pane_id}\t#{pane_index}\t#{pane_current_command}\t#{window_name}\t#{window_zoomed_flag}",
    ]).pipe(Effect.map((result) => parsePaneListOutput(result.stdout.trim()))),
    () => Effect.succeed([] as TmuxPaneInfo[]),
  );
}
```

- [ ] **Step 4: Fix the existing parsePaneListOutput tests**

The existing test at line 70 uses 4-column output. Update it to include the zoom column:

```typescript
test("parses pane list output", () => {
  const output = "%0\t0\tbash\tshell\t0\n%1\t1\tvim\teditor\t0";
  const panes = parsePaneListOutput(output);
  expect(panes).toHaveLength(2);
  expect(panes[0]).toEqual({
    paneId: "%0",
    paneIndex: 0,
    command: "bash",
    window: "shell",
    zoomed: false,
  });
  expect(panes[1]).toEqual({
    paneId: "%1",
    paneIndex: 1,
    command: "vim",
    window: "editor",
    zoomed: false,
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/tmux.ts tests/tmux.test.ts
git commit -m "feat(tmux): add zoomed state to TmuxPaneInfo"
```

---

### Task 2: Add zoomPane and killPane to TmuxService

**Files:**
- Modify: `src/services/tmux.ts:36-87` (TmuxService interface)
- Modify: `src/services/tmux.ts:522-619` (liveTmuxService)

- [ ] **Step 1: Add zoomPane and killPane to the TmuxService interface**

Add two new methods to the `TmuxService` interface in `src/services/tmux.ts`:

```typescript
zoomPane: (
  paneId: string,
) => Effect.Effect<void, WctError, WctRuntimeServices>;
killPane: (
  paneId: string,
) => Effect.Effect<void, WctError, WctRuntimeServices>;
```

- [ ] **Step 2: Add implementation functions**

Add after `killSessionImpl` (around line 430):

```typescript
function zoomPaneImpl(paneId: string) {
  return execProcess("tmux", ["resize-pane", "-Z", "-t", paneId]).pipe(
    Effect.asVoid,
  );
}

function killPaneImpl(paneId: string) {
  return execProcess("tmux", ["kill-pane", "-t", paneId]).pipe(Effect.asVoid);
}
```

- [ ] **Step 3: Wire into liveTmuxService**

Add to the `liveTmuxService` object:

```typescript
zoomPane: (paneId) =>
  Effect.mapError(zoomPaneImpl(paneId), (error) =>
    commandError("tmux_error", `Failed to zoom pane '${paneId}'`, error),
  ),
killPane: (paneId) =>
  Effect.mapError(killPaneImpl(paneId), (error) =>
    commandError(
      "tmux_error",
      `Failed to kill pane '${paneId}': ${getProcessErrorMessage(error)}`,
      error,
    ),
  ),
```

- [ ] **Step 4: Run tests to verify nothing is broken**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tmux.ts
git commit -m "feat(tmux): add zoomPane and killPane service methods"
```

---

### Task 3: Expose zoomPane and killPane in useTmux hook

**Files:**
- Modify: `src/tui/hooks/useTmux.ts`
- Test: `tests/tui/use-tmux.test.ts`

- [ ] **Step 1: Write failing tests**

Add to the existing `useTmux hook` describe block in `tests/tui/use-tmux.test.ts`:

```typescript
test("zoomPane returns false when no active client exists", async () => {
  mockRunPromise
    .mockResolvedValueOnce([]) // listClients
    .mockResolvedValueOnce(null); // listSessions

  const harness = await renderUseTmux();
  await flush(10);

  const result = await harness.value.zoomPane("%0");
  expect(result).toBe(false);

  harness.unmount();
});

test("killPane returns false when no active client exists", async () => {
  mockRunPromise
    .mockResolvedValueOnce([]) // listClients
    .mockResolvedValueOnce(null); // listSessions

  const harness = await renderUseTmux();
  await flush(10);

  const result = await harness.value.killPane("%0");
  expect(result).toBe(false);

  harness.unmount();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — `zoomPane` and `killPane` not defined on hook return value.

- [ ] **Step 3: Add zoomPane and killPane callbacks to useTmux**

In `src/tui/hooks/useTmux.ts`, add after the `jumpToPane` callback:

```typescript
const zoomPane = useCallback(
  async (paneId: string) => {
    if (!client) return false;
    try {
      await tuiRuntime.runPromise(
        TmuxService.use((service) => service.zoomPane(paneId)),
      );
      return true;
    } catch {
      return false;
    }
  },
  [client],
);

const killPane = useCallback(
  async (paneId: string) => {
    if (!client) return false;
    try {
      await tuiRuntime.runPromise(
        TmuxService.use((service) => service.killPane(paneId)),
      );
      return true;
    } catch {
      return false;
    }
  },
  [client],
);
```

Add `zoomPane` and `killPane` to the return object:

```typescript
return {
  client,
  sessions,
  panes,
  error,
  switchSession,
  jumpToPane,
  zoomPane,
  killPane,
  refreshSessions,
  discoverClient,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/useTmux.ts tests/tui/use-tmux.test.ts
git commit -m "feat(tui): expose zoomPane and killPane in useTmux hook"
```

---

### Task 4: Add ConfirmKill mode to TUI types

**Files:**
- Modify: `src/tui/types.ts`
- Test: `tests/tui/types.test.ts`

- [ ] **Step 1: Update Mode type with ConfirmKill variant**

In `src/tui/types.ts`, add the new mode variant to the `Mode` type:

```typescript
export type Mode =
  | { type: "Navigate" }
  | { type: "Search" }
  | { type: "OpenModal" }
  | { type: "Expanded"; worktreeKey: string }
  | { type: "ConfirmKill"; paneId: string; label: string; worktreeKey: string };
```

Add the constructor to the `Mode` namespace object:

```typescript
export const Mode = {
  Navigate: { type: "Navigate" } as Mode,
  Search: { type: "Search" } as Mode,
  OpenModal: { type: "OpenModal" } as Mode,
  Expanded: (worktreeKey: string): Mode => ({
    type: "Expanded",
    worktreeKey,
  }),
  ConfirmKill: (paneId: string, label: string, worktreeKey: string): Mode => ({
    type: "ConfirmKill",
    paneId,
    label,
    worktreeKey,
  }),
};
```

- [ ] **Step 2: Run tests to verify nothing is broken**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/types.ts
git commit -m "feat(tui): add ConfirmKill mode variant"
```

---

### Task 5: Render zoom indicator in DetailRow

**Files:**
- Modify: `src/tui/components/DetailRow.tsx`
- Modify: `src/tui/App.tsx` (buildTreeItems pane detail meta)

- [ ] **Step 1: Pass zoomed state through buildTreeItems**

In `src/tui/App.tsx`, update the pane detail item in `buildTreeItems` to include `zoomed` in meta:

```typescript
for (const pane of sessionPanes) {
  items.push({
    type: "detail",
    repoIndex: ri,
    worktreeIndex: wi,
    detailKind: "pane",
    label: `${pane.window}:${pane.paneIndex} ${pane.command}`,
    meta: { zoomed: pane.zoomed },
    action: () => jumpToPane(pane.paneId),
  });
}
```

- [ ] **Step 2: Update the meta type on TreeItem**

In `src/tui/types.ts`, update the `meta` field type on the detail variant of `TreeItem`:

```typescript
meta?: { state?: string; paneRef?: string; zoomed?: boolean };
```

- [ ] **Step 3: Render zoom icon in DetailRow**

In `src/tui/components/DetailRow.tsx`, update the `pane` case:

```typescript
case "pane": {
  const zoomIcon = meta?.zoomed ? "🔍 " : "";
  return (
    <Box>
      <Text>{indent}</Text>
      <Text color={isSelected ? "cyan" : "dim"} bold={isSelected}>
        {prefix}
        {zoomIcon}
        {label}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run tests to verify nothing is broken**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/DetailRow.tsx src/tui/App.tsx src/tui/types.ts
git commit -m "feat(tui): render magnifying glass icon on zoomed panes"
```

---

### Task 6: Wire z/x keybindings and ConfirmKill mode in App

**Files:**
- Modify: `src/tui/App.tsx`

- [ ] **Step 1: Destructure zoomPane and killPane from useTmux**

In `src/tui/App.tsx`, update the `useTmux` destructure:

```typescript
const {
  client,
  sessions,
  panes,
  error: tmuxError,
  switchSession,
  jumpToPane,
  zoomPane,
  killPane,
  refreshSessions,
  discoverClient,
} = useTmux();
```

- [ ] **Step 2: Add helper to resolve pane info from selected item**

Add a helper function inside the `App` component, after `handleSpaceSwitch`:

```typescript
function getSelectedPaneInfo(): { paneId: string; label: string } | null {
  const item = treeItems[selectedIndex];
  if (!item || item.type !== "detail" || item.detailKind !== "pane") return null;
  const repo = filteredRepos[item.repoIndex];
  if (!repo) return null;
  const wt = repo.worktrees[item.worktreeIndex];
  if (!wt) return null;
  const sessionName = formatSessionName(basename(wt.path));
  const sessionPanes = panes.get(sessionName);
  if (!sessionPanes) return null;
  // Match pane by label
  const labelParts = item.label.split(" ");
  const windowPane = labelParts[0]; // "window:paneIndex"
  if (!windowPane) return null;
  const [window, paneIndexStr] = windowPane.split(":");
  const paneIndex = Number(paneIndexStr);
  const pane = sessionPanes.find(
    (p) => p.window === window && p.paneIndex === paneIndex,
  );
  if (!pane) return null;
  return { paneId: pane.paneId, label: item.label };
}
```

- [ ] **Step 3: Add z and x handlers to handleExpandedInput**

In `handleExpandedInput`, add before the existing `if (input === " ")` block:

```typescript
if (input === "z") {
  const paneInfo = getSelectedPaneInfo();
  if (!paneInfo) return;
  zoomPane(paneInfo.paneId).then(() => refreshSessions());
  return;
}

if (input === "x") {
  const paneInfo = getSelectedPaneInfo();
  if (!paneInfo) return;
  if (mode.type !== "Expanded") return;
  setMode(Mode.ConfirmKill(paneInfo.paneId, paneInfo.label, mode.worktreeKey));
  return;
}
```

- [ ] **Step 4: Add handleConfirmKillInput function**

Add a new input handler in the `App` component:

```typescript
function handleConfirmKillInput(input: string, key: Key) {
  if (mode.type !== "ConfirmKill") return;

  if (key.escape) {
    setMode(Mode.Expanded(mode.worktreeKey));
    return;
  }

  if (key.return) {
    const { paneId, worktreeKey } = mode;
    setMode(Mode.Expanded(worktreeKey));
    killPane(paneId).then(() => refreshSessions());
    return;
  }
}
```

- [ ] **Step 5: Wire ConfirmKill into useInput switch**

Update the `useInput` switch statement to handle the new mode:

```typescript
switch (mode.type) {
  case "Navigate":
    return handleNavigateInput(input, key);
  case "Search":
    return handleSearchInput(input, key);
  case "OpenModal":
    return;
  case "Expanded":
    return handleExpandedInput(input, key);
  case "ConfirmKill":
    return handleConfirmKillInput(input, key);
}
```

Also update the global `q` guard to exclude `ConfirmKill`:

```typescript
if (input === "q" && mode.type !== "OpenModal" && mode.type !== "Search" && mode.type !== "ConfirmKill") {
  exit();
  return;
}
```

- [ ] **Step 6: Run tests to verify nothing is broken**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tui/App.tsx
git commit -m "feat(tui): wire z/x keybindings and ConfirmKill mode"
```

---

### Task 7: Update StatusBar for pane hints and confirm kill prompt

**Files:**
- Modify: `src/tui/components/StatusBar.tsx`
- Modify: `src/tui/App.tsx` (pass selectedPaneRow and mode to StatusBar)

- [ ] **Step 1: Update StatusBar props and ConfirmKill rendering**

In `src/tui/components/StatusBar.tsx`:

```typescript
import { Box, Text, useStdout } from "ink";
import type { Mode } from "../types";

interface Props {
  mode: Mode;
  searchQuery?: string;
  selectedPaneRow?: boolean;
}

function getHints(mode: Mode, selectedPaneRow?: boolean): [string, string] {
  switch (mode.type) {
    case "Navigate":
      return [
        "↑↓:navigate  ←→:expand/collapse  space:switch  o:open",
        "c:close  /:search  q:quit",
      ];
    case "Search":
      return ["type to filter", "esc:cancel  enter:done"];
    case "OpenModal":
      return ["", ""];
    case "Expanded":
      return [
        selectedPaneRow
          ? "↑↓:navigate  ←:collapse  space:jump  z:zoom  x:kill"
          : "↑↓:navigate  ←:collapse  space:action  o:open",
        "/:search  q:quit",
      ];
    case "ConfirmKill":
      return ["", ""];
  }
}

export function StatusBar({ mode, searchQuery, selectedPaneRow }: Props) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 50;
  const divider = "─".repeat(Math.max(1, cols));

  if (mode.type === "Search") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{divider}</Text>
        <Text color="cyan">/{searchQuery}</Text>
        <Text dimColor>{getHints(mode)[1]}</Text>
      </Box>
    );
  }

  if (mode.type === "ConfirmKill") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{divider}</Text>
        <Text color="red" bold>
          Kill pane {mode.label}?
        </Text>
        <Text dimColor>enter:confirm  esc:cancel</Text>
      </Box>
    );
  }

  const [line1, line2] = getHints(mode, selectedPaneRow);
  return (
    <Box flexDirection="column">
      <Text dimColor>{divider}</Text>
      <Text dimColor>{line1}</Text>
      <Text dimColor>{line2}</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Pass selectedPaneRow to StatusBar from App**

In `src/tui/App.tsx`, compute `selectedPaneRow` and pass it to `StatusBar`:

```typescript
const selectedItem = treeItems[selectedIndex];
const selectedPaneRow =
  selectedItem?.type === "detail" && selectedItem.detailKind === "pane";
```

Update the StatusBar JSX:

```typescript
<StatusBar
  mode={mode}
  searchQuery={searchQuery}
  selectedPaneRow={selectedPaneRow}
/>
```

- [ ] **Step 3: Run tests to verify nothing is broken**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tui/components/StatusBar.tsx src/tui/App.tsx
git commit -m "feat(tui): update StatusBar with pane hints and confirm kill prompt"
```

---

### Task 8: Manual testing and final verification

- [ ] **Step 1: Run the full test suite**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 2: Manual test zoom toggle**

Run `bun run src/index.ts tui`, navigate to a worktree with a multi-pane session, expand it with right arrow, select a pane row, press `z`. Verify:
- The tmux pane zooms in the other terminal
- After refresh, the 🔍 icon appears on pane rows in the zoomed window
- Pressing `z` again unzooms and the icon disappears

- [ ] **Step 3: Manual test kill pane**

Select a pane row, press `x`. Verify:
- The StatusBar shows the red confirmation prompt with the pane label
- Pressing `esc` cancels and returns to expanded mode
- Pressing `enter` kills the pane and refreshes the pane list
- If it was the last pane in a window, the window is removed by tmux

- [ ] **Step 4: Commit any fixes**

If any issues were found and fixed, commit them.

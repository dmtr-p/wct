# TUI UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the wct TUI more responsive and information-rich with inline action feedback, expandable worktree details, a redesigned Open modal, and context-aware status bar.

**Architecture:** Incremental enhancement of the existing Ink/React TUI. Light mode system refactor first, then layer features. Each task produces a working, testable commit.

**Tech Stack:** Ink 6, React 19, Bun runtime, `gh` CLI for GitHub data, `tmux` CLI for pane data.

**Spec:** `docs/superpowers/specs/2026-03-22-tui-ux-improvements-design.md`

---

## File Structure

**Modified files:**
| File | Responsibility |
|------|---------------|
| `src/tui/App.tsx` | Mode state, keyboard dispatch, pendingActions, expanded worktree state |
| `src/tui/components/TreeView.tsx` | Render detail rows, phantom items |
| `src/tui/components/WorktreeItem.tsx` | Expanded indicator, inline pending status, color change (blue→yellow) |
| `src/tui/components/StatusBar.tsx` | Accept mode + submode, render context-aware 2-line hints |
| `src/tui/components/OpenModal.tsx` | Complete redesign: mode selector → three form paths |
| `src/tui/components/Modal.tsx` | Minor: support wider content for scrollable lists |
| `src/tui/hooks/useTmux.ts` | Add per-session pane data fetching |

**New files:**
| File | Responsibility |
|------|---------------|
| `src/tui/types.ts` | Shared types: Mode enum, TreeItem (extended with detail variant), PendingAction, PRInfo, PaneInfo |
| `src/tui/hooks/useGitHub.ts` | Background GitHub data fetching (60s cadence) |
| `src/tui/hooks/useBlink.ts` | Blinking cursor toggle hook (500ms setInterval) |
| `src/tui/components/DetailRow.tsx` | Renders a single expanded detail row (notification, PR, check, pane) |
| `src/tui/components/ScrollableList.tsx` | Reusable filterable scrollable list for modal |
| `tests/tui/types.test.ts` | Tests for shared type utilities |
| `tests/tui/scrollable-list.test.ts` | Tests for scrollable list logic (filtering, windowing) |
| `tests/tui/use-github.test.ts` | Tests for GitHub data parsing |

---

## Task 1: Extract Shared Types (`src/tui/types.ts`)

**Files:**
- Create: `src/tui/types.ts`
- Create: `tests/tui/types.test.ts`
- Modify: `src/tui/components/TreeView.tsx` (remove `TreeItem` export, import from `../types` instead)
- Modify: `src/tui/App.tsx` (update `TreeItem` import from `./components/TreeView` to `./types`)

- [ ] **Step 1: Create `src/tui/types.ts` with mode enum and TreeItem types**

```typescript
// src/tui/types.ts

/** TUI interaction modes */
export type Mode =
  | { type: "Navigate" }
  | { type: "Search" }
  | { type: "OpenModal" }
  | { type: "Expanded"; worktreeKey: string };

export const Mode = {
  Navigate: { type: "Navigate" } as Mode,
  Search: { type: "Search" } as Mode,
  OpenModal: { type: "OpenModal" } as Mode,
  Expanded: (worktreeKey: string): Mode => ({
    type: "Expanded",
    worktreeKey,
  }),
};

/** Items in the flat tree list */
export type TreeItem =
  | { type: "repo"; repoIndex: number }
  | { type: "worktree"; repoIndex: number; worktreeIndex: number }
  | {
      type: "detail";
      repoIndex: number;
      worktreeIndex: number;
      detailKind: DetailKind;
      label: string;
      action?: () => void;
    };

export type DetailKind =
  | "notification-header"
  | "notification"
  | "pr"
  | "check"
  | "pane-header"
  | "pane";

/** Pending action for optimistic UI */
export interface PendingAction {
  type: "opening" | "closing" | "starting";
  branch: string;
  project: string;
}

/** GitHub PR info from `gh` CLI */
export interface PRInfo {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  checks: CheckInfo[];
}

export interface CheckInfo {
  name: string;
  state: string; // SUCCESS, FAILURE, PENDING, IN_PROGRESS, etc.
}

/** Tmux pane info */
export interface PaneInfo {
  index: number;
  command: string;
  window: string;
}

/** Format a pending action key */
export function pendingKey(project: string, branch: string): string {
  return `${project}/${branch}`;
}

/** Map check state to display icon */
export function checkIcon(state: string): string {
  switch (state) {
    case "SUCCESS":
      return "✓";
    case "FAILURE":
      return "✗";
    case "PENDING":
    case "QUEUED":
    case "IN_PROGRESS":
      return "◌";
    case "SKIPPED":
      return "⊘";
    case "CANCELLED":
      return "⊘";
    default:
      return "?";
  }
}

/** Map check state to Ink color name */
export function checkColor(
  state: string,
): "green" | "red" | "yellow" | "dim" | undefined {
  switch (state) {
    case "SUCCESS":
      return "green";
    case "FAILURE":
      return "red";
    case "PENDING":
    case "QUEUED":
    case "IN_PROGRESS":
      return "yellow";
    default:
      return "dim";
  }
}
```

- [ ] **Step 2: Write tests for utility functions**

```typescript
// tests/tui/types.test.ts
import { describe, expect, test } from "vitest";
import { checkColor, checkIcon, pendingKey } from "../../src/tui/types";

describe("pendingKey", () => {
  test("formats project/branch", () => {
    expect(pendingKey("wct", "feat/tui")).toBe("wct/feat/tui");
  });
});

describe("checkIcon", () => {
  test("returns ✓ for SUCCESS", () => {
    expect(checkIcon("SUCCESS")).toBe("✓");
  });
  test("returns ✗ for FAILURE", () => {
    expect(checkIcon("FAILURE")).toBe("✗");
  });
  test("returns ◌ for PENDING", () => {
    expect(checkIcon("PENDING")).toBe("◌");
  });
  test("returns ◌ for IN_PROGRESS", () => {
    expect(checkIcon("IN_PROGRESS")).toBe("◌");
  });
  test("returns ? for unknown state", () => {
    expect(checkIcon("UNKNOWN")).toBe("?");
  });
});

describe("checkColor", () => {
  test("returns green for SUCCESS", () => {
    expect(checkColor("SUCCESS")).toBe("green");
  });
  test("returns red for FAILURE", () => {
    expect(checkColor("FAILURE")).toBe("red");
  });
  test("returns yellow for PENDING", () => {
    expect(checkColor("PENDING")).toBe("yellow");
  });
  test("returns dim for unknown", () => {
    expect(checkColor("SKIPPED")).toBe("dim");
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/tui/types.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/tui/types.ts tests/tui/types.test.ts
git commit -m "feat(tui): add shared types for mode system, tree items, and GitHub data"
```

---

## Task 2: Mode System & StatusBar Refactor

**Files:**
- Modify: `src/tui/components/StatusBar.tsx`
- Modify: `src/tui/App.tsx`
- Read: `src/tui/types.ts` (uses Mode type from Task 1)

- [ ] **Step 1: Rewrite StatusBar to accept Mode and render context-aware hints**

Replace the entire content of `src/tui/components/StatusBar.tsx`:

```tsx
// src/tui/components/StatusBar.tsx
import { Box, Text } from "ink";
import type { Mode } from "../types";

interface Props {
  mode: Mode;
  searchQuery?: string;
  /** Sub-mode context for OpenModal: which step the user is on */
  modalStep?: "selector" | "form" | "list";
}

function getHints(
  mode: Mode,
  modalStep?: "selector" | "form" | "list",
): [string, string] {
  switch (mode.type) {
    case "Navigate":
      return [
        "↑↓:navigate  ←→:expand/collapse  space:switch  o:open",
        "c:close  j:jump  /:search  q:quit",
      ];
    case "Search":
      return ["type to filter", "esc:cancel  enter:done"];
    case "OpenModal":
      if (modalStep === "selector") {
        return ["↑↓:select  enter:confirm", "esc:cancel"];
      }
      if (modalStep === "list") {
        return [
          "↑↓:select  type:filter  tab:next field",
          "ctrl+s:submit  esc:cancel",
        ];
      }
      return ["tab:next  shift+tab:prev", "ctrl+s:submit  esc:cancel"];
    case "Expanded":
      return [
        "↑↓:navigate  enter:action  ←:collapse  space:switch",
        "o:open  q:quit",
      ];
  }
}

export function StatusBar({ mode, searchQuery, modalStep }: Props) {
  if (mode.type === "Search") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text dimColor>
            ─────────────────────────────────────────────────
          </Text>
        </Box>
        <Text color="cyan">/{searchQuery}</Text>
        <Text dimColor>{getHints(mode)[1]}</Text>
      </Box>
    );
  }

  const [line1, line2] = getHints(mode, modalStep);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text dimColor>
          ─────────────────────────────────────────────────
        </Text>
      </Box>
      <Text dimColor>{line1}</Text>
      <Text dimColor>{line2}</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Refactor App.tsx to use Mode type and dispatch pattern**

In `src/tui/App.tsx`, make the following changes:

1. Replace the `mode` state (currently `useState<"normal" | "search">("normal")`) with:
```typescript
const [mode, setMode] = useState<Mode>(Mode.Navigate);
```

2. Replace the `showOpenModal` state — it's now `mode.type === "OpenModal"`.

3. Refactor the `useInput` handler to dispatch by `mode.type`:
```typescript
useInput((input, key) => {
  // Global keys (work in any mode)
  if (input === "q" && mode.type !== "OpenModal" && mode.type !== "Search") {
    process.exit(0);
  }

  switch (mode.type) {
    case "Navigate":
      return handleNavigateInput(input, key);
    case "Search":
      return handleSearchInput(input, key);
    case "OpenModal":
      // Modal handles its own input
      return;
    case "Expanded":
      return handleExpandedInput(input, key);
  }
});
```

4. Extract `handleNavigateInput`, `handleSearchInput`, `handleExpandedInput` as functions inside the component. Move the existing keyboard logic into these handlers. Key changes:
   - In `handleNavigateInput`: replace `key.return` switch-session logic with `input === " "` (space). Keep `key.return` for repo expand/collapse only.
   - Add `→` on worktree to enter Expanded mode: `setMode(Mode.Expanded(pendingKey(repo.project, worktree.branch)))`.
   - Add `handleExpandedInput`: `←`/`esc` returns to Navigate, `space` switches, `key.return` triggers detail row action.
   - **Important:** Also replace usages of `showOpenModal` boolean:
     - `if (showOpenModal) return;` → handled by the `switch` dispatch (OpenModal case returns early)
     - `isActive: !showOpenModal` on `useInput` → remove, the switch handles it
     - `OpenModal visible={showOpenModal}` → `OpenModal visible={mode.type === "OpenModal"}`
     - `setShowOpenModal(true)` → `setMode(Mode.OpenModal)`
     - `setShowOpenModal(false)` → `setMode(Mode.Navigate)`

5. Extract two reusable helper functions inside the component for cross-mode reuse:
   ```typescript
   /** Move selection up or down in the flat tree list */
   function navigateTree(direction: 1 | -1) {
     setSelectedIndex((prev) => {
       const next = prev + direction;
       if (next < 0 || next >= treeItems.length) return prev;
       return next;
     });
   }

   /** Switch to worktree's tmux session, creating one if needed */
   function handleSpaceSwitch() {
     const item = treeItems[selectedIndex];
     if (item?.type !== "worktree") return;
     const repo = filtered[item.repoIndex];
     const wt = repo.worktrees[item.worktreeIndex];
     const sessionName = formatSessionName(path.basename(wt.path));
     const hasSession = sessions.some((s) => s.name === sessionName);
     if (hasSession) {
       switchSession(sessionName);
     } else {
       // Will be fleshed out in Task 3 with pending action tracking
       const proc = Bun.spawn(["wct", "up", "--no-attach"], {
         cwd: wt.path,
         stdio: ["ignore", "ignore", "ignore"],
       });
       proc.exited.then((code) => {
         if (code === 0) switchSession(sessionName);
       });
     }
   }
   ```
   These are called from both `handleNavigateInput` and `handleExpandedInput`.

6. Update StatusBar usage:

5. Update StatusBar usage:
```tsx
<StatusBar mode={mode} searchQuery={searchQuery} />
```

- [ ] **Step 3: Verify existing functionality still works**

Run: `bun test`
Expected: All existing tests PASS

Run manually: `bun run src/index.ts tui`
Verify: Navigation, search, quit, open modal all still work. Status bar shows correct hints per mode.

- [ ] **Step 4: Commit**

```bash
git add src/tui/App.tsx src/tui/components/StatusBar.tsx
git commit -m "feat(tui): refactor mode system with typed dispatch and context-aware status bar"
```

---

## Task 3: Space to Switch/Create Session

**Files:**
- Modify: `src/tui/App.tsx` (keyboard handler from Task 2)

- [ ] **Step 1: Update space handler in `handleNavigateInput`**

In `src/tui/App.tsx`, within `handleNavigateInput`, add space handling:

```typescript
if (input === " ") {
  const item = treeItems[selectedIndex];
  if (item?.type !== "worktree") return;
  const repo = filtered[item.repoIndex];
  const wt = repo.worktrees[item.worktreeIndex];
  const sessionName = formatSessionName(path.basename(wt.path));
  const hasSession = sessions.some((s) => s.name === sessionName);

  if (hasSession) {
    switchSession(sessionName);
  } else {
    // Create session with wct up, then switch
    const key = pendingKey(repo.project, wt.branch);
    setPendingActions((prev) => new Map(prev).set(key, {
      type: "starting",
      branch: wt.branch,
      project: repo.project,
    }));
    const proc = Bun.spawn(
      ["wct", "up", "--no-attach"],
      { cwd: wt.path, stdio: ["ignore", "ignore", "ignore"] },
    );
    proc.exited.then((code) => {
      if (code === 0) {
        switchSession(sessionName);
      }
      setPendingActions((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    });
  }
}
```

- [ ] **Step 2: Remove old `key.return` switch logic in Navigate mode**

Remove the existing `key.return` handler for worktree items in Navigate mode that calls `switchSession` / spawns `wct up`. Keep `key.return` only for repo node expand/collapse.

- [ ] **Step 3: Test manually**

Run: `bun run src/index.ts tui`
Verify: Space on a worktree with session switches to it. Space on a worktree without session starts one.

- [ ] **Step 4: Commit**

```bash
git add src/tui/App.tsx
git commit -m "feat(tui): use space to switch/create tmux sessions"
```

---

## Task 4: Inline Optimistic Updates

**Files:**
- Modify: `src/tui/App.tsx` (add pendingActions state)
- Modify: `src/tui/components/WorktreeItem.tsx` (render pending status)
- Modify: `src/tui/components/TreeView.tsx` (render phantom items)

- [ ] **Step 1: Add pendingActions state to App.tsx**

In `src/tui/App.tsx`:

```typescript
const [pendingActions, setPendingActions] = useState<Map<string, PendingAction>>(new Map());
```

Import `PendingAction` and `pendingKey` from `../types`.

- [ ] **Step 2: Update `handleOpen` to add phantom worktree**

Modify the existing `handleOpen` function in App.tsx. After spawning `wct open`, add:

```typescript
const key = pendingKey(repo.project, result.branch);
setPendingActions((prev) =>
  new Map(prev).set(key, {
    type: "opening",
    branch: result.branch,
    project: repo.project,
  }),
);

// On process exit, clear pending (refresh will pick up real data or show error)
proc.exited.then((code) => {
  if (code !== 0) {
    // Show error briefly, then clear
    setTimeout(() => {
      setPendingActions((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    }, 5000);
  } else {
    // Success: trigger immediate refresh so real worktree appears,
    // then clear phantom (avoids gap between phantom disappearing and real appearing)
    refreshAll().then(() => {
      setPendingActions((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    });
  }
});
```

- [ ] **Step 3: Update close handler similarly**

In the `c` key handler, add pending "closing" state before spawning `wct close`.

- [ ] **Step 4: Update WorktreeItem to show pending status**

Add `pendingStatus` prop to `WorktreeItem`:

```tsx
// In WorktreeItem.tsx props:
interface Props {
  branch: string;
  hasSession: boolean;
  isAttached: boolean;
  sync: string;
  changedFiles: number;
  notifications: number;
  isSelected: boolean;
  pendingStatus?: "opening" | "closing" | "starting";
}
```

In the render, when `pendingStatus` is set:
- `"opening"`: render entire line in yellow italic with "opening..." suffix
- `"closing"`: render with `dimColor` and "closing..." suffix
- `"starting"`: render "starting..." next to the `○` indicator

- [ ] **Step 5: Update TreeView to inject phantom items**

In `TreeView.tsx`, accept a `pendingActions` prop. After the real worktrees for each repo, append phantom `TreeItem` entries for any `pendingActions` with `type: "opening"` matching that repo's project. Render phantom items as `WorktreeItem` with `pendingStatus="opening"`.

- [ ] **Step 6: Change WorktreeItem changed files color from blue to yellow**

In `src/tui/components/WorktreeItem.tsx`, change `color="blue"` to `color="yellow"` for the changed files count indicator.

- [ ] **Step 7: Test manually**

Run: `bun run src/index.ts tui`
Verify:
- Press `o`, create new branch → see "opening..." phantom item appear immediately
- Press `c` on a worktree → see it dim with "closing..."
- Press space on worktree without session → see "starting..."

- [ ] **Step 8: Commit**

```bash
git add src/tui/App.tsx src/tui/components/WorktreeItem.tsx src/tui/components/TreeView.tsx
git commit -m "feat(tui): inline optimistic updates for open, close, and session start"
```

---

## Task 5: Blinking Cursor Hook

**Files:**
- Create: `src/tui/hooks/useBlink.ts`

- [ ] **Step 1: Create the useBlink hook**

```typescript
// src/tui/hooks/useBlink.ts
import { useEffect, useState } from "react";

/**
 * Returns a boolean that toggles every `intervalMs` milliseconds.
 * Use to show/hide a cursor character.
 */
export function useBlink(intervalMs = 500): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setVisible((v) => !v), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return visible;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tui/hooks/useBlink.ts
git commit -m "feat(tui): add useBlink hook for cursor animation"
```

---

## Task 6: ScrollableList Component

**Files:**
- Create: `src/tui/components/ScrollableList.tsx`
- Create: `tests/tui/scrollable-list.test.ts`

- [ ] **Step 1: Write tests for scrollable list logic**

```typescript
// tests/tui/scrollable-list.test.ts
import { describe, expect, test } from "vitest";
import {
  filterItems,
  getVisibleWindow,
} from "../../src/tui/components/ScrollableList";

describe("filterItems", () => {
  const items = [
    { label: "feat/auth", value: "feat/auth" },
    { label: "fix/cors", value: "fix/cors" },
    { label: "chore/deps", value: "chore/deps" },
  ];

  test("returns all items when query is empty", () => {
    expect(filterItems(items, "")).toEqual(items);
  });

  test("filters by substring match", () => {
    expect(filterItems(items, "feat")).toEqual([items[0]]);
  });

  test("is case insensitive", () => {
    expect(filterItems(items, "CORS")).toEqual([items[1]]);
  });

  test("returns empty when no match", () => {
    expect(filterItems(items, "xyz")).toEqual([]);
  });
});

describe("getVisibleWindow", () => {
  test("returns all items when fewer than maxVisible", () => {
    const result = getVisibleWindow(3, 0, 10);
    expect(result).toEqual({ start: 0, end: 3, hasAbove: false, hasBelow: false });
  });

  test("returns window around selected index", () => {
    const result = getVisibleWindow(20, 12, 10);
    expect(result.end - result.start).toBe(10);
    expect(result.start).toBeLessThanOrEqual(12);
    expect(result.end).toBeGreaterThan(12);
    expect(result.hasAbove).toBe(true);
    expect(result.hasBelow).toBe(true);
  });

  test("clamps to start", () => {
    const result = getVisibleWindow(20, 0, 10);
    expect(result).toEqual({ start: 0, end: 10, hasAbove: false, hasBelow: true });
  });

  test("clamps to end", () => {
    const result = getVisibleWindow(20, 19, 10);
    expect(result).toEqual({ start: 10, end: 20, hasAbove: true, hasBelow: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/tui/scrollable-list.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Create ScrollableList component with exported logic functions**

```tsx
// src/tui/components/ScrollableList.tsx
import { Box, Text } from "ink";
import { useBlink } from "../hooks/useBlink";

export interface ListItem {
  label: string;
  value: string;
  /** Optional secondary text (e.g., PR title) */
  description?: string;
}

/** Filter items by case-insensitive substring match on label */
export function filterItems(items: ListItem[], query: string): ListItem[] {
  if (!query) return items;
  const lower = query.toLowerCase();
  return items.filter((item) => item.label.toLowerCase().includes(lower));
}

/** Compute visible window for scrolling */
export function getVisibleWindow(
  totalItems: number,
  selectedIndex: number,
  maxVisible: number,
): { start: number; end: number; hasAbove: boolean; hasBelow: boolean } {
  if (totalItems <= maxVisible) {
    return { start: 0, end: totalItems, hasAbove: false, hasBelow: false };
  }

  // Center the window around selectedIndex
  let start = Math.max(0, selectedIndex - Math.floor(maxVisible / 2));
  let end = start + maxVisible;

  if (end > totalItems) {
    end = totalItems;
    start = end - maxVisible;
  }

  return {
    start,
    end,
    hasAbove: start > 0,
    hasBelow: end < totalItems,
  };
}

interface Props {
  items: ListItem[];
  selectedIndex: number;
  filterQuery: string;
  maxVisible?: number;
  isFocused: boolean;
}

export function ScrollableList({
  items,
  selectedIndex,
  filterQuery,
  maxVisible = 10,
  isFocused,
}: Props) {
  const cursorVisible = useBlink();
  const filtered = filterItems(items, filterQuery);
  const { start, end, hasAbove, hasBelow } = getVisibleWindow(
    filtered.length,
    selectedIndex,
    maxVisible,
  );
  const visible = filtered.slice(start, end);

  return (
    <Box flexDirection="column">
      {hasAbove && <Text dimColor>  ▲</Text>}
      {visible.map((item, i) => {
        const actualIndex = start + i;
        const isSelected = actualIndex === selectedIndex;
        return (
          <Box key={item.value}>
            <Text color={isSelected && isFocused ? "cyan" : undefined}>
              {isSelected ? "▸ " : "  "}
            </Text>
            <Text bold={isSelected} color={isSelected ? undefined : "dim"}>
              {item.label}
            </Text>
            {item.description && (
              <Text dimColor> {item.description}</Text>
            )}
          </Box>
        );
      })}
      {hasBelow && <Text dimColor>  ▼</Text>}
      {filtered.length === 0 && (
        <Text dimColor>  No matches</Text>
      )}
      {isFocused && filterQuery && (
        <Text dimColor>  filter: {filterQuery}{cursorVisible ? "▎" : " "}</Text>
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/tui/scrollable-list.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/ScrollableList.tsx tests/tui/scrollable-list.test.ts
git commit -m "feat(tui): add ScrollableList component with filtering and windowing"
```

---

## Task 7: Extend useTmux with Pane Data

**Files:**
- Modify: `src/tui/hooks/useTmux.ts`

- [ ] **Step 1: Add PaneInfo to useTmux state and fetching**

Import `PaneInfo` from `../types`. Add state:

```typescript
const [panes, setPanes] = useState<Map<string, PaneInfo[]>>(new Map());
```

Add a `refreshPanes` function that runs after `refreshSessions`:

```typescript
const refreshPanes = useCallback(async (sessionList: TmuxSessionInfo[]) => {
  const paneMap = new Map<string, PaneInfo[]>();
  await Promise.all(
    sessionList.map(async (session) => {
      try {
        const result = await runTmux([
          "list-panes",
          "-s",
          "-t",
          session.name,
          "-F",
          "#{pane_index}:#{pane_current_command}:#{window_name}",
        ]);
        const lines = result.split("\n").filter(Boolean);
        paneMap.set(
          session.name,
          lines.map((line) => {
            const [idx, cmd, win] = line.split(":");
            return { index: Number(idx), command: cmd || "", window: win || "" };
          }),
        );
      } catch {
        // Ignore pane fetch errors
      }
    }),
  );
  setPanes(paneMap);
}, []);
```

Call `refreshPanes(sessionList)` inside `refreshSessions` after parsing sessions.

Return `panes` from the hook alongside existing values.

- [ ] **Step 2: Test manually**

Run: `bun run src/index.ts tui`
Verify: No visible change yet (pane data is fetched but not rendered).

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/useTmux.ts
git commit -m "feat(tui): fetch per-session tmux pane data"
```

---

## Task 8: GitHub Data Hook (`useGitHub`)

**Files:**
- Create: `src/tui/hooks/useGitHub.ts`
- Create: `tests/tui/use-github.test.ts`

- [ ] **Step 1: Write tests for GitHub data parsing**

```typescript
// tests/tui/use-github.test.ts
import { describe, expect, test } from "vitest";
import { parseGhPrList, parseGhPrChecks } from "../../src/tui/hooks/useGitHub";

describe("parseGhPrList", () => {
  test("parses JSON output from gh pr list", () => {
    const json = JSON.stringify([
      { number: 34, title: "feat: TUI sidebar", state: "OPEN", headRefName: "feat/tui" },
      { number: 31, title: "fix: migration", state: "MERGED", headRefName: "fix/migrate" },
    ]);
    const result = parseGhPrList(json);
    expect(result).toHaveLength(2);
    expect(result[0].number).toBe(34);
    expect(result[0].headRefName).toBe("feat/tui");
  });

  test("returns empty array for empty JSON", () => {
    expect(parseGhPrList("[]")).toEqual([]);
  });

  test("returns empty array for invalid JSON", () => {
    expect(parseGhPrList("not json")).toEqual([]);
  });
});

describe("parseGhPrChecks", () => {
  test("parses JSON output from gh pr checks", () => {
    const json = JSON.stringify([
      { name: "build", state: "SUCCESS" },
      { name: "test", state: "FAILURE" },
    ]);
    const result = parseGhPrChecks(json);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "build", state: "SUCCESS" });
  });

  test("returns empty array for invalid JSON", () => {
    expect(parseGhPrChecks("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/tui/use-github.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Create useGitHub hook**

```typescript
// src/tui/hooks/useGitHub.ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckInfo, PRInfo } from "../types";
import type { RepoInfo } from "./useRegistry";

const GITHUB_POLL_INTERVAL = 60_000; // 60 seconds

/** Parse `gh pr list --json ...` output */
export function parseGhPrList(stdout: string): Omit<PRInfo, "checks">[] {
  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) return [];
    return data.map((pr: Record<string, unknown>) => ({
      number: pr.number as number,
      title: pr.title as string,
      state: pr.state as PRInfo["state"],
      headRefName: pr.headRefName as string,
    }));
  } catch {
    return [];
  }
}

/** Parse `gh pr checks --json ...` output */
export function parseGhPrChecks(stdout: string): CheckInfo[] {
  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) return [];
    return data.map((c: Record<string, unknown>) => ({
      name: c.name as string,
      state: c.state as string,
    }));
  } catch {
    return [];
  }
}

async function runGh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`gh exited with ${code}`);
  return text.trim();
}

async function fetchRepoData(
  repo: RepoInfo,
): Promise<[string, PRInfo][]> {
  const entries: [string, PRInfo][] = [];
  try {
    const prJson = await runGh(
      ["pr", "list", "--json", "number,title,state,headRefName", "--limit", "20"],
      repo.repoPath,
    );
    const prs = parseGhPrList(prJson);

    await Promise.all(
      prs.map(async (pr) => {
        let checks: CheckInfo[] = [];
        try {
          const checksJson = await runGh(
            ["pr", "checks", String(pr.number), "--json", "name,state"],
            repo.repoPath,
          );
          checks = parseGhPrChecks(checksJson);
        } catch {
          // Checks may not be available
        }
        const key = `${repo.project}/${pr.headRefName}`;
        entries.push([key, { ...pr, checks }]);
      }),
    );
  } catch {
    // gh not installed or not authenticated — silently skip
  }
  return entries;
}

export function useGitHub(repos: RepoInfo[]) {
  const [prData, setPrData] = useState<Map<string, PRInfo>>(new Map());
  const [loading, setLoading] = useState(false);
  const reposRef = useRef(repos);
  reposRef.current = repos;

  const refresh = useCallback(async () => {
    if (reposRef.current.length === 0) return;
    setLoading(true);
    try {
      const allEntries = await Promise.all(
        reposRef.current.map(fetchRepoData),
      );
      setPrData(new Map(allEntries.flat()));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, GITHUB_POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  return { prData, loading, refresh };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/tui/use-github.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Wire useGitHub into App.tsx**

In `src/tui/App.tsx`, add:

```typescript
const { prData } = useGitHub(repos);
```

Pass `prData` down to `TreeView` (will be used in Task 9).

- [ ] **Step 6: Commit**

```bash
git add src/tui/hooks/useGitHub.ts tests/tui/use-github.test.ts src/tui/App.tsx
git commit -m "feat(tui): add useGitHub hook for background PR/checks fetching"
```

---

## Task 9: Expandable Worktree Items & DetailRow

**Files:**
- Create: `src/tui/components/DetailRow.tsx`
- Modify: `src/tui/App.tsx` (expanded state, tree item building)
- Modify: `src/tui/components/TreeView.tsx` (render detail rows)
- Modify: `src/tui/components/WorktreeItem.tsx` (expand indicator)

- [ ] **Step 1: Create DetailRow component**

```tsx
// src/tui/components/DetailRow.tsx
import { Box, Text } from "ink";
import type { DetailKind } from "../types";
import { checkColor, checkIcon } from "../types";

interface Props {
  kind: DetailKind;
  label: string;
  isSelected: boolean;
  /** Extra data for rendering (e.g., check state) */
  meta?: { state?: string; paneRef?: string };
}

export function DetailRow({ kind, label, isSelected, meta }: Props) {
  const prefix = isSelected ? "❯ " : "  ";
  const indent = kind === "notification-header" || kind === "pr" || kind === "pane-header"
    ? "      "    // section header: 6 spaces
    : "        "; // section item: 8 spaces

  switch (kind) {
    case "notification-header":
    case "pane-header":
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : undefined} bold={isSelected} dimColor={!isSelected}>
            {prefix}{label}
          </Text>
        </Box>
      );

    case "notification":
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : "red"}>
            {prefix}!  {label}
          </Text>
          {meta?.paneRef && <Text dimColor> (pane {meta.paneRef})</Text>}
        </Box>
      );

    case "pr":
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
            {prefix}{label}
          </Text>
        </Box>
      );

    case "check": {
      const icon = checkIcon(meta?.state ?? "");
      const color = checkColor(meta?.state ?? "");
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : undefined}>
            {prefix}
          </Text>
          <Text color={color}>{icon}</Text>
          <Text color={isSelected ? "cyan" : "dim"}> {label}</Text>
        </Box>
      );
    }

    case "pane":
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : "dim"}>
            {prefix}{label}
          </Text>
        </Box>
      );
  }
}
```

- [ ] **Step 2: Add expanded worktree state to App.tsx**

In `src/tui/App.tsx`:

```typescript
/** Key of the currently expanded worktree, or null */
const [expandedWorktree, setExpandedWorktree] = useState<string | null>(null);
```

- [ ] **Step 3: Update tree item building to include detail rows**

Modify the `buildTreeItems` function (or equivalent logic in App.tsx) to insert detail `TreeItem` entries after an expanded worktree. For the expanded worktree, look up:
- Queue items matching that worktree's branch + project → notification rows
- PR data from `prData` map → PR + check rows
- Pane data from `panes` map → pane rows

Each detail row gets an `action` callback:
- Notification: `() => jumpToPane(session, pane)`
- PR: `() => Bun.spawn(["gh", "pr", "view", "--web", String(pr.number)], { cwd: repoPath })`
- Check: no action
- Pane: `() => jumpToPane(session, paneIndex)`

- [ ] **Step 4: Handle → key in Navigate mode to expand worktree**

In `handleNavigateInput`, when `key.rightArrow` is pressed on a worktree item:

```typescript
if (key.rightArrow) {
  const item = treeItems[selectedIndex];
  if (item?.type === "worktree") {
    const repo = filtered[item.repoIndex];
    const wt = repo.worktrees[item.worktreeIndex];
    const wtKey = pendingKey(repo.project, wt.branch);
    setExpandedWorktree((prev) => (prev === wtKey ? null : wtKey));
    setMode(Mode.Expanded(wtKey));
  } else if (item?.type === "repo") {
    // Existing expand behavior
    toggleRepoExpanded(filtered[item.repoIndex].project);
  }
}
```

- [ ] **Step 5: Handle Expanded mode input**

```typescript
function handleExpandedInput(input: string, key: Key) {
  if (key.leftArrow || key.escape) {
    setExpandedWorktree(null);
    setMode(Mode.Navigate);
    return;
  }
  if (key.upArrow || key.downArrow) {
    navigateTree(key.upArrow ? -1 : 1);
    return;
  }
  if (key.return) {
    const item = treeItems[selectedIndex];
    if (item?.type === "detail" && item.action) {
      item.action();
    }
    return;
  }
  if (input === " ") {
    handleSpaceSwitch();
    return;
  }
  if (input === "/") {
    // Collapse expanded view and enter search mode (per spec)
    setExpandedWorktree(null);
    setMode(Mode.Search);
    setSearchQuery("");
    return;
  }
  if (input === "o") {
    setMode(Mode.OpenModal);
    return;
  }
  if (input === "q") {
    process.exit(0);
  }
}
```

- [ ] **Step 6: Update WorktreeItem to show expand indicator**

Add `isExpanded` and `hasExpandableData` props to WorktreeItem. `hasExpandableData` is computed by `TreeView` — it is `true` when the worktree has any notifications, PR data, or pane data available. When `isExpanded` is true, show `▼` before the session indicator. When collapsed but expandable, show `▶`.

```tsx
// In WorktreeItem.tsx props:
isExpanded?: boolean;
hasExpandableData?: boolean;

// In WorktreeItem render:
const expandArrow = isExpanded ? "▼ " : hasExpandableData ? "▶ " : "  ";
```

- [ ] **Step 7: Update TreeView to render DetailRow**

Import `DetailRow` and render it for `type: "detail"` items in the tree.

- [ ] **Step 8: Test manually**

Run: `bun run src/index.ts tui`
Verify:
- `→` on a worktree expands it, showing notifications (if any), PR info, checks, panes
- `←` or `esc` collapses
- `enter` on a notification jumps to pane
- `enter` on a PR opens in browser
- Only one worktree expanded at a time

- [ ] **Step 9: Commit**

```bash
git add src/tui/components/DetailRow.tsx src/tui/App.tsx src/tui/components/TreeView.tsx src/tui/components/WorktreeItem.tsx
git commit -m "feat(tui): expandable worktree items with PR, checks, panes, notifications"
```

---

## Task 10: Open Modal Redesign

**Files:**
- Modify: `src/tui/components/OpenModal.tsx` (complete rewrite)
- Modify: `src/tui/App.tsx` (pass new props, handle modal mode)

This is the largest task. The current OpenModal (339 lines) is replaced with a two-step flow.

- [ ] **Step 1: Define modal types and props**

```typescript
// At top of OpenModal.tsx
type ModalStep = "selector" | "newBranch" | "fromPR" | "existingBranch";

export interface OpenModalProps {
  visible: boolean;
  onSubmit: (result: OpenModalResult) => void;
  onCancel: () => void;
  defaultBase: string;
  profileNames: string[];
  repoProject: string;
  repoPath: string;
  prList: PRInfo[];
  onStepChange: (step: "selector" | "form" | "list") => void;
}
```

**OpenModalResult** stays the same shape but `pr` is now the full PR number string.

- [ ] **Step 2: Implement ModeSelector sub-component**

```tsx
function ModeSelector({ onSelect, onCancel }: {
  onSelect: (step: ModalStep) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const cursorVisible = useBlink();
  const options: { label: string; step: ModalStep }[] = [
    { label: "New Branch", step: "newBranch" },
    { label: "Open from PR", step: "fromPR" },
    { label: "Existing Branch", step: "existingBranch" },
  ];

  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(options.length - 1, s + 1));
    if (key.return) onSelect(options[selected].step);
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>Open Worktree</Text>
      <Box height={1} />
      {options.map((opt, i) => {
        const isSel = i === selected;
        return (
          <Text key={opt.step} color={isSel ? "cyan" : "dim"}>
            {isSel ? "[" : "["} {isSel ? "" : ""}{opt.label}
            {isSel && cursorVisible ? "▎" : " "}{isSel ? "]" : "]"}
          </Text>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 3: Implement BracketInput sub-component for text fields**

```tsx
function BracketInput({ label, value, isFocused, onChange }: {
  label: string;
  value: string;
  isFocused: boolean;
  onChange: (v: string) => void;
}) {
  const cursorVisible = useBlink();

  useInput((input, key) => {
    if (!isFocused) return;
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      onChange(value + input);
    }
  }, { isActive: isFocused });

  return (
    <Box flexDirection="column">
      <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>{label}</Text>
      <Text color={isFocused ? "cyan" : "dim"}>
        {"[ "}<Text color={isFocused ? undefined : "dim"}>{value}</Text>
        {isFocused && cursorVisible ? "▎" : " "}{" ]"}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 4: Implement PromptArea sub-component (horizontal lines style)**

```tsx
function PromptArea({ value, isFocused, onChange }: {
  value: string;
  isFocused: boolean;
  onChange: (v: string) => void;
}) {
  const cursorVisible = useBlink();

  useInput((input, key) => {
    if (!isFocused) return;
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
    } else if (key.return) {
      onChange(value + "\n");
    } else if (input && !key.ctrl && !key.meta) {
      onChange(value + input);
    }
  }, { isActive: isFocused });

  return (
    <Box flexDirection="column">
      <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>Prompt</Text>
      <Text dimColor>───────────────────────────────</Text>
      <Text color={isFocused ? undefined : "dim"}>
        {value || (isFocused ? "" : "optional")}
        {isFocused && cursorVisible ? "▎" : ""}
      </Text>
      <Text dimColor>───────────────────────────────</Text>
    </Box>
  );
}
```

- [ ] **Step 5: Implement NewBranchForm**

Uses BracketInput for branch/base/profile, PromptArea for prompt, toggle checkboxes. Tab cycles through fields. Ctrl+S submits. Esc cancels back to selector or closes modal.

- [ ] **Step 6: Implement FromPRForm**

Uses ScrollableList (from Task 6) for PR selection, with PR items built from `prList` prop. When a PR is selected and user tabs to next field, the PR number is stored. BracketInput for profile (if applicable). PromptArea for prompt. Toggles. Notifies parent `onStepChange("list")` when PR list is focused, `onStepChange("form")` when other fields are focused.

- [ ] **Step 7: Implement ExistingBranchForm**

Fetches branches on mount via:
```typescript
useEffect(() => {
  const proc = Bun.spawn(
    ["git", "branch", "-r", "--format=%(refname:short)"],
    { cwd: repoPath, stdout: "pipe", stderr: "ignore" },
  );
  new Response(proc.stdout).text().then((text) => {
    setBranches(
      text.split("\n").filter(Boolean)
        .map((b) => b.replace(/^origin\//, ""))
        .filter((b) => b !== "HEAD")
    );
  });
}, [repoPath]);
```

Uses ScrollableList for branch selection. PromptArea for prompt. Toggles. No base field.

- [ ] **Step 8: Wire OpenModal to dispatch by ModalStep**

The main `OpenModal` component manages `step` state. When `visible` becomes true, reset to `"selector"`. Render `ModeSelector` or the appropriate form based on `step`. The parent App.tsx `useInput` returns early when `mode.type === "OpenModal"` (from Task 2), so the modal's `useInput` hooks are the only active ones.

All text inputs use bracket `[ value▎ ]` focus style with blinking cursor from `useBlink`.
Prompt uses horizontal lines (two `Text` lines of `───`).

- [ ] **Step 2: Update App.tsx to pass new props**

When mode is OpenModal:
- Determine repo context from selected tree item
- Pass `defaultBase`, `profileNames`, `repoProject`, `repoPath`, `prList` (from prData filtered to this repo)
- Pass `onStepChange` to update StatusBar's `modalStep` prop

- [ ] **Step 3: Test manually**

Run: `bun run src/index.ts tui`
Verify:
- `o` shows mode selector with 3 options
- Selecting "New Branch" shows form with bracket inputs and horizontal-line prompt
- Selecting "Open from PR" shows scrollable PR list
- Selecting "Existing Branch" shows scrollable branch list
- Tab navigates between fields
- Ctrl+S submits
- Esc cancels at any step
- Status bar shows correct hints per modal step

- [ ] **Step 4: Run lint**

Run: `bunx biome check --write`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/OpenModal.tsx src/tui/App.tsx
git commit -m "feat(tui): redesign open modal with three-path flow and scrollable lists"
```

---

## Task 11: Final Integration & Polish

**Files:**
- Modify: `src/tui/App.tsx` (final wiring)
- All modified files (lint pass)

- [ ] **Step 1: Verify all modes transition correctly**

Test each transition from the spec's mode transition table:
- Navigate → Search (via `/`)
- Navigate → OpenModal (via `o`)
- Navigate → Expanded (via `→` on worktree)
- Search → Navigate (via `esc` clears, `enter` keeps filter)
- OpenModal → Navigate (via `esc` or submit)
- Expanded → Navigate (via `←` or `esc`)
- Expanded → OpenModal (via `o`)
- Expanded → Search (via `/`, collapses expanded view)

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Run lint and format**

Run: `bunx biome check --write`
Expected: No errors

- [ ] **Step 4: Manual smoke test**

Run: `bun run src/index.ts tui`
Full walkthrough:
1. Navigate tree, expand/collapse repos
2. Space to switch sessions
3. Space on worktree without session (creates + switches)
4. Open modal → New Branch → submit → see "opening..." phantom
5. Open modal → From PR → filter → submit
6. Open modal → Existing Branch → select → submit
7. Expand worktree → see notifications, PR, checks, panes
8. Jump to notification pane from expanded view
9. Search → filter → done
10. Close worktree → see "closing..." indicator
11. Verify status bar changes per mode

- [ ] **Step 5: Commit any final fixes**

```bash
git add src/tui/ tests/tui/
git commit -m "feat(tui): final integration and polish for UX improvements"
```

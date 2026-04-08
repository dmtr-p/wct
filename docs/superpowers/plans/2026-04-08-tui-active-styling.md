# TUI Active Styling & Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace inverse-background selection with bold text, add ellipsis truncation for long branches, and move git stats to a second line shown only when selected/expanded.

**Architecture:** All changes are in 4 TUI component files. A `truncateBranch` helper is added inline in `WorktreeItem.tsx`. Terminal width is threaded from `App.tsx` → `TreeView` → `WorktreeItem`.

**Tech Stack:** React (Ink), TypeScript, Vitest

---

### Task 1: Remove inverse styling from RepoNode

**Files:**
- Modify: `src/tui/components/RepoNode.tsx:26-27`

- [ ] **Step 1: Remove `inverse` from RepoNode**

In `src/tui/components/RepoNode.tsx`, change the `<Text>` element that renders the project name:

```tsx
      <Text
        color={isSelected ? "cyan" : "yellow"}
        bold={isSelected}
      >
```

Remove `inverse={isSelected}` — only `bold` and `color` remain.

- [ ] **Step 2: Verify visually**

Run: `bun run src/index.ts tui`

Confirm that navigating to a repo node shows it in bold cyan text without a background highlight.

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/RepoNode.tsx
git commit -m "tui: replace inverse with bold for active repo node"
```

---

### Task 2: Remove inverse styling and add truncation to WorktreeItem

**Files:**
- Modify: `src/tui/components/WorktreeItem.tsx`
- Modify: `src/tui/components/TreeView.tsx`
- Modify: `src/tui/App.tsx`

- [ ] **Step 1: Add `maxWidth` prop to WorktreeItem and implement truncation**

In `src/tui/components/WorktreeItem.tsx`, add `maxWidth` to the `Props` interface:

```tsx
interface Props {
  branch: string;
  hasSession: boolean;
  isAttached: boolean;
  sync: string;
  changedFiles: number;
  notifications: number;
  isSelected: boolean;
  pendingStatus?: "opening" | "closing" | "starting";
  isExpanded?: boolean;
  hasExpandableData?: boolean;
  maxWidth: number;
}
```

Add a truncation helper before the component function:

```tsx
function truncateBranch(branch: string, available: number): string {
  if (branch.length <= available) return branch;
  if (available <= 3) return branch.slice(0, Math.max(1, available));
  return `${branch.slice(0, available - 3)}...`;
}
```

- [ ] **Step 2: Apply truncation and remove inverse in the main return**

Inside the `WorktreeItem` component, compute the truncated branch name and remove `inverse`:

```tsx
  // prefix=4, indicator=2, expandIcon=0or2, attached=0or2, margin=2
  const overhead = 4 + 2 + (expandIcon ? 2 : 0) + (isAttached ? 2 : 0) + 2;
  const available = Math.max(10, maxWidth - overhead);
  const displayBranch = truncateBranch(branch, available);
```

Change the branch `<Text>` element (around line 75-82) — remove `inverse={isSelected}`:

```tsx
      <Text
        color={isSelected ? "cyan" : undefined}
        bold={isSelected}
      >
        {" "}
        {displayBranch}
      </Text>
```

Also apply `displayBranch` in the `pendingStatus === "opening"` and `pendingStatus === "closing"` return paths (replace `{branch}` with `{displayBranch}`). Note: the truncation values must be computed before the early returns, so move the overhead/available/displayBranch calculation to the top of the component body, right after the existing local variables.

- [ ] **Step 3: Thread `maxWidth` through TreeView**

In `src/tui/components/TreeView.tsx`, add `maxWidth: number` to the `Props` interface:

```tsx
interface Props {
  repos: RepoInfo[];
  sessions: Array<{ name: string; attached: boolean }>;
  queueItems: QueueItem[];
  expandedRepos: Set<string>;
  selectedIndex: number;
  items: TreeItem[];
  pendingActions: Map<string, PendingAction>;
  prData: Map<string, PRInfo>;
  panes: Map<string, PaneInfo[]>;
  expandedWorktreeKey: string | null;
  maxWidth: number;
}
```

Pass it to every `<WorktreeItem>` render (both the normal and phantom renders):

```tsx
        <WorktreeItem
          ...existing props...
          maxWidth={maxWidth}
        />
```

There are 3 `<WorktreeItem>` renders in `TreeView.tsx` — add `maxWidth={maxWidth}` to all three.

- [ ] **Step 4: Pass terminal columns from App.tsx to TreeView**

In `src/tui/App.tsx`, the component already has `const { stdout } = useStdout();`. Add columns:

```tsx
  const termCols = stdout?.columns ?? 80;
```

Pass it to `<TreeView>`:

```tsx
        <TreeView
          ...existing props...
          maxWidth={termCols}
        />
```

- [ ] **Step 5: Verify visually**

Run: `bun run src/index.ts tui`

Confirm:
- Selected branches show bold cyan text, no background highlight
- If you have a long branch name, it truncates with `...`

- [ ] **Step 6: Commit**

```bash
git add src/tui/components/WorktreeItem.tsx src/tui/components/TreeView.tsx src/tui/App.tsx
git commit -m "tui: replace inverse with bold, add branch name truncation"
```

---

### Task 3: Move git stats to second line

**Files:**
- Modify: `src/tui/components/WorktreeItem.tsx`

- [ ] **Step 1: Add `isExpanded` check and restructure layout**

The component already receives `isExpanded` as a prop. Change the main return block to wrap everything in a `<Box flexDirection="column">` and conditionally render stats on a second line.

Replace the main return (the final `return` statement, not the early returns for pending states) with:

```tsx
  const showStats = isSelected || isExpanded;
  const hasStats =
    (sync && sync !== "\u2713") || changedFiles > 0 || notifications > 0;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
        {expandIcon ? <Text dimColor>{expandIcon}</Text> : null}
        <Text color={indicatorColor}>
          {indicator}
          {pendingStatus === "starting" ? (
            <Text dimColor> starting...</Text>
          ) : null}
        </Text>
        <Text
          color={isSelected ? "cyan" : undefined}
          bold={isSelected}
        >
          {" "}
          {displayBranch}
        </Text>
        <Text dimColor>{attached}</Text>
      </Box>
      {showStats && hasStats ? (
        <Box>
          <Text>{"        "}</Text>
          {sync && sync !== "\u2713" ? <Text dimColor>{sync}</Text> : null}
          {changedFiles > 0 ? (
            <Text color="yellow">
              {sync && sync !== "\u2713" ? " " : ""}~{changedFiles}
            </Text>
          ) : null}
          {notifications > 0 ? (
            <Text color="yellow">
              {(sync && sync !== "\u2713") || changedFiles > 0 ? " " : ""}!
              {notifications}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
```

This removes the inline stats from the branch line and renders them on a second line only when `showStats && hasStats`.

- [ ] **Step 2: Verify visually**

Run: `bun run src/index.ts tui`

Confirm:
- Unselected branches show only the branch name, no stats
- Selected branches show stats on a second indented line
- Expanded branches (right arrow) also show stats on second line
- If a branch has no stats (no sync diff, no changes, no notifications), no second line appears

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/WorktreeItem.tsx
git commit -m "tui: move git stats to second line, show only when active/expanded"
```

---

### Task 4: Add tests for truncateBranch

**Files:**
- Create: `tests/tui/worktree-item.test.ts`
- Modify: `src/tui/components/WorktreeItem.tsx` (export `truncateBranch`)

- [ ] **Step 1: Export `truncateBranch` from WorktreeItem**

In `src/tui/components/WorktreeItem.tsx`, change the function declaration to be exported:

```tsx
export function truncateBranch(branch: string, available: number): string {
```

- [ ] **Step 2: Write tests**

Create `tests/tui/worktree-item.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { truncateBranch } from "../../src/tui/components/WorktreeItem";

describe("truncateBranch", () => {
  test("returns branch unchanged when it fits", () => {
    expect(truncateBranch("feat/auth", 20)).toBe("feat/auth");
  });

  test("returns branch unchanged when exactly at limit", () => {
    expect(truncateBranch("feat/auth", 9)).toBe("feat/auth");
  });

  test("truncates with ellipsis when too long", () => {
    expect(truncateBranch("feature/very-long-branch-name", 15)).toBe(
      "feature/very...",
    );
  });

  test("handles very small available space", () => {
    expect(truncateBranch("feature/branch", 3)).toBe("...");
  });

  test("handles available less than 3", () => {
    const result = truncateBranch("feature/branch", 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun run test`

Expected: All tests pass, including the new `truncateBranch` tests.

- [ ] **Step 4: Commit**

```bash
git add src/tui/components/WorktreeItem.tsx tests/tui/worktree-item.test.ts
git commit -m "tui: add tests for truncateBranch helper"
```

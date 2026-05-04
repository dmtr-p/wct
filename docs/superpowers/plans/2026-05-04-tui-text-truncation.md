# TUI Text Truncation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Truncate project names in `RepoNode` and pane/check/pane-header labels in `DetailRow` to fit the terminal width, matching the existing branch-name truncation pattern.

**Architecture:** Extract `truncateBranch` from `WorktreeItem.tsx` into a shared `src/tui/utils/truncate.ts` alongside a new `truncateWithPrefix` helper. Tighten the `DetailItem` type so pane meta is always required. Thread `maxWidth` into `RepoNode` and `DetailRow` via `TreeView`.

**Tech Stack:** TypeScript, React/Ink (TUI), Vitest

---

## File Map

| File | Action |
|---|---|
| `src/tui/utils/truncate.ts` | **Create** — `truncateBranch` + `truncateWithPrefix` |
| `tests/tui/truncate.test.ts` | **Create** — utility tests |
| `src/tui/components/WorktreeItem.tsx` | **Modify** — import from `../utils/truncate`, remove local definition |
| `tests/tui/worktree-item.test.ts` | **Modify** — update import path |
| `src/tui/types.ts` | **Modify** — `meta: TMeta` (required), extend pane meta shape |
| `src/tui/tree-helpers.ts` | **Modify** — set `window`, `paneIndex`, `command` on pane meta |
| `tests/tui/build-tree-items.test.ts` | **Modify** — assert new meta fields; update pane item construction |
| `tests/tui/detail-row.test.tsx` | **Modify** — add missing required meta fields; add truncation tests |
| `src/tui/components/RepoNode.tsx` | **Modify** — add `maxWidth` prop; truncate project name |
| `tests/tui/repo-node.test.tsx` | **Create** — RepoNode truncation render tests |
| `src/tui/components/DetailRow.tsx` | **Modify** — add `maxWidth` prop; truncate pane/pane-header/check |
| `src/tui/components/TreeView.tsx` | **Modify** — pass `maxWidth` to `RepoNode` and `DetailRow` |
| `tests/tui/tree-view-wiring.test.tsx` | **Create** — smoke test: narrow maxWidth truncates project name |

---

## Task 1: Shared truncation utility

**Files:**
- Create: `src/tui/utils/truncate.ts`
- Create: `tests/tui/truncate.test.ts`
- Modify: `src/tui/components/WorktreeItem.tsx`
- Modify: `tests/tui/worktree-item.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/tui/truncate.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  truncateBranch,
  truncateWithPrefix,
} from "../../src/tui/utils/truncate";

describe("truncateBranch", () => {
  test("returns text unchanged when it fits", () => {
    expect(truncateBranch("feat/auth", 20)).toBe("feat/auth");
  });

  test("returns text unchanged at exact limit", () => {
    expect(truncateBranch("feat/auth", 9)).toBe("feat/auth");
  });

  test("truncates with ellipsis when too long", () => {
    expect(truncateBranch("feature/very-long-branch-name", 15)).toBe(
      "feature/very...",
    );
  });

  test("handles available === 3", () => {
    expect(truncateBranch("feature/branch", 3)).toBe("...");
  });

  test("handles available less than 3", () => {
    expect(truncateBranch("feature/branch", 2)).toBe("..");
    expect(truncateBranch("feature/branch", 1)).toBe(".");
  });

  test("returns empty string when available is 0", () => {
    expect(truncateBranch("feature/branch", 0)).toBe("");
  });
});

describe("truncateWithPrefix", () => {
  test("returns prefix+rest when both fit", () => {
    expect(truncateWithPrefix("1:0 ", "vim", 20)).toBe("1:0 vim");
  });

  test("returns prefix+rest at exact limit", () => {
    // "1:0 vim" is 7 chars
    expect(truncateWithPrefix("1:0 ", "vim", 7)).toBe("1:0 vim");
  });

  test("preserves prefix and truncates rest when too long", () => {
    // prefix "1:0 " (4), rest "bun run dev --watch" (19), available 15
    // → "1:0 " + truncateBranch("bun run dev --watch", 11)
    // → "1:0 " + "bun run ..."
    expect(truncateWithPrefix("1:0 ", "bun run dev --watch", 15)).toBe(
      "1:0 bun run ...",
    );
  });

  test("falls back to truncateBranch when available === prefix.length + 3", () => {
    // prefix "1:0 " (4), available 7 (= 4+3) — fallback threshold
    // truncateBranch("1:0 vim this is long", 7) → "1:0 ..."
    expect(truncateWithPrefix("1:0 ", "vim this is long", 7)).toBe("1:0 ...");
  });

  test("falls back to truncateBranch when available < prefix.length + 3", () => {
    // prefix "1:0 " (4), available 5 (< 7) — fallback
    // truncateBranch("1:0 vim this is long", 5) → "1:..."
    expect(truncateWithPrefix("1:0 ", "vim this is long", 5)).toBe("1:...");
  });

  test("handles empty rest", () => {
    expect(truncateWithPrefix("1:0 ", "", 10)).toBe("1:0 ");
    expect(truncateWithPrefix("1:0 ", "", 4)).toBe("1:0 ");
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
bun run test tests/tui/truncate.test.ts
```

Expected: FAIL — `Cannot find module '../../src/tui/utils/truncate'`

- [ ] **Step 3: Create `src/tui/utils/truncate.ts`**

```ts
export function truncateBranch(text: string, available: number): string {
  if (text.length <= available) return text;
  if (available <= 3) return ".".repeat(Math.max(0, available));
  return `${text.slice(0, available - 3)}...`;
}

export function truncateWithPrefix(
  prefix: string,
  rest: string,
  available: number,
): string {
  if (prefix.length + rest.length <= available) return prefix + rest;
  if (available <= prefix.length + 3)
    return truncateBranch(prefix + rest, available);
  return prefix + truncateBranch(rest, available - prefix.length);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
bun run test tests/tui/truncate.test.ts
```

Expected: all 11 tests PASS

- [ ] **Step 5: Update `src/tui/components/WorktreeItem.tsx`**

Add import at the top (after existing imports):

```ts
import { truncateBranch } from "../utils/truncate";
```

Remove the local `truncateBranch` definition (lines 17–21):

```ts
// DELETE these lines:
export function truncateBranch(branch: string, available: number): string {
  if (branch.length <= available) return branch;
  if (available <= 3) return ".".repeat(Math.max(0, available));
  return `${branch.slice(0, available - 3)}...`;
}
```

`branchBudget` stays — it is only used inside `WorktreeItem.tsx`.

- [ ] **Step 6: Update `tests/tui/worktree-item.test.ts`**

Change the import from `WorktreeItem` to `truncate`:

```ts
// Before:
import { truncateBranch } from "../../src/tui/components/WorktreeItem";

// After:
import { truncateBranch } from "../../src/tui/utils/truncate";
```

- [ ] **Step 7: Run the full test suite to confirm no regressions**

```bash
bun run test
```

Expected: all tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/tui/utils/truncate.ts tests/tui/truncate.test.ts \
        src/tui/components/WorktreeItem.tsx tests/tui/worktree-item.test.ts
git commit -m "refactor(tui): extract truncation helpers to shared utility"
```

---

## Task 2: Tighten `DetailItem` type and extend pane meta

**Files:**
- Modify: `src/tui/types.ts`
- Modify: `src/tui/tree-helpers.ts`
- Modify: `tests/tui/build-tree-items.test.ts`
- Modify: `tests/tui/detail-row.test.tsx`

- [ ] **Step 1: Update `src/tui/types.ts`**

In the `DetailItem` generic (currently around line 134), change `meta?: TMeta` to `meta: TMeta`:

```ts
// Before (the non-undefined branch):
  : {
      type: "detail";
      repoIndex: number;
      worktreeIndex: number;
      detailKind: TKind;
      label: string;
      action?: () => void;
      meta?: TMeta;
    };

// After:
  : {
      type: "detail";
      repoIndex: number;
      worktreeIndex: number;
      detailKind: TKind;
      label: string;
      action?: () => void;
      meta: TMeta;
    };
```

Also update the `"pane"` union member to include the three new required fields:

```ts
// Before (line ~130):
| DetailItem<"pane", { paneId: string; zoomed?: boolean; active?: boolean }>

// After:
| DetailItem<"pane", {
    paneId: string;
    zoomed?: boolean;
    active?: boolean;
    window: string;
    paneIndex: number;
    command: string;
  }>
```

- [ ] **Step 2: Update `src/tui/tree-helpers.ts`**

In the pane-building loop (around line 148–161), add `window`, `paneIndex`, and `command` to `meta`:

```ts
// Before:
items.push({
  type: "detail",
  repoIndex: ri,
  worktreeIndex: wi,
  detailKind: "pane",
  label: `${pane.window}:${pane.paneIndex} ${pane.command}`,
  meta: {
    paneId: pane.paneId,
    zoomed: pane.zoomed,
    active: pane.active,
  },
  action: () => jumpToPane(pane.paneId),
});

// After:
items.push({
  type: "detail",
  repoIndex: ri,
  worktreeIndex: wi,
  detailKind: "pane",
  label: `${pane.window}:${pane.paneIndex} ${pane.command}`,
  meta: {
    paneId: pane.paneId,
    zoomed: pane.zoomed,
    active: pane.active,
    window: pane.window,
    paneIndex: pane.paneIndex,
    command: pane.command,
  },
  action: () => jumpToPane(pane.paneId),
});
```

- [ ] **Step 3: Run the type checker to confirm it compiles**

```bash
bunx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Update `tests/tui/build-tree-items.test.ts`**

The existing test at the top of the file verifies that zoomed/active are passed through. Extend it to also assert the three new meta fields. Find the assertion block (after `buildTreeItems(...)` is called) and add:

```ts
// Find the pane detail item from the returned items array:
const paneItem = items.find(
  (i) => i.type === "detail" && i.detailKind === "pane",
) as Extract<TreeItem, { type: "detail"; detailKind: "pane" }> | undefined;

expect(paneItem).toBeDefined();
expect(paneItem!.meta.window).toBe("main");
expect(paneItem!.meta.paneIndex).toBe(0);
expect(paneItem!.meta.command).toBe("bun run dev");
expect(paneItem!.meta.zoomed).toBe(true);
expect(paneItem!.meta.active).toBe(true);
```

- [ ] **Step 5: Update `tests/tui/detail-row.test.tsx`**

The three pane item objects in the existing test (lines ~55–82) have `meta` without `paneId`, `window`, `paneIndex`, or `command`. Add all required fields:

```ts
// First pane item (zoomed + active):
meta: { paneId: "%0", zoomed: true, active: true, window: "main", paneIndex: 0, command: "bash" },

// Second pane item (zoomed, not active):
meta: { paneId: "%1", zoomed: true, active: false, window: "main", paneIndex: 1, command: "node" },

// Third pane item (not zoomed, active):
meta: { paneId: "%2", zoomed: false, active: true, window: "main", paneIndex: 2, command: "zsh" },
```

- [ ] **Step 6: Run tests to confirm everything passes**

```bash
bun run test
```

Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/tui/types.ts src/tui/tree-helpers.ts \
        tests/tui/build-tree-items.test.ts tests/tui/detail-row.test.tsx
git commit -m "feat(tui): tighten DetailItem pane meta — required window/paneIndex/command"
```

---

## Task 3: `RepoNode` project name truncation

**Files:**
- Create: `tests/tui/repo-node.test.tsx`
- Modify: `src/tui/components/RepoNode.tsx`
- Modify: `src/tui/components/TreeView.tsx`

- [ ] **Step 1: Write the failing tests**

Create `tests/tui/repo-node.test.tsx`:

```tsx
import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { RepoNode } from "../../src/tui/components/RepoNode";

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 80;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

async function renderRepoNode(props: React.ComponentProps<typeof RepoNode>) {
  const { stdout, stdin } = createStdoutStdin();
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  const { render } = await import("ink");
  const instance = render(React.createElement(RepoNode, props), {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    output: chunks.join(""),
    unmount() {
      instance.unmount();
    },
  };
}

describe("RepoNode", () => {
  test("renders full project name when maxWidth is wide", async () => {
    // overhead=4, project="my-project" (10), available=36 → no truncation
    const { output, unmount } = await renderRepoNode({
      project: "my-project",
      expanded: false,
      isSelected: false,
      isChildSelected: false,
      worktreeCount: 1,
      maxWidth: 40,
    });
    expect(output).toContain("my-project");
    unmount();
  });

  test("truncates project name when maxWidth is tight", async () => {
    // overhead=4, project="my-project" (10), maxWidth=10 → available=6 → "my-..."
    const { output, unmount } = await renderRepoNode({
      project: "my-project",
      expanded: false,
      isSelected: false,
      isChildSelected: false,
      worktreeCount: 1,
      maxWidth: 10,
    });
    expect(output).toContain("my-...");
    expect(output).not.toContain("my-project");
    unmount();
  });

  test("renders truncated name at exact width", async () => {
    // overhead=4, project="my-project" (10), maxWidth=14 → available=10 → no truncation
    const { output, unmount } = await renderRepoNode({
      project: "my-project",
      expanded: false,
      isSelected: false,
      isChildSelected: false,
      worktreeCount: 1,
      maxWidth: 14,
    });
    expect(output).toContain("my-project");
    unmount();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
bun run test tests/tui/repo-node.test.tsx
```

Expected: FAIL — `maxWidth` is not a valid prop on `RepoNode`

- [ ] **Step 3: Update `src/tui/components/RepoNode.tsx`**

Add `maxWidth` to the `Props` interface and apply truncation:

```tsx
import { Box, Text } from "ink";
import { truncateBranch } from "../utils/truncate";

interface Props {
  project: string;
  expanded: boolean;
  isSelected: boolean;
  isChildSelected: boolean;
  worktreeCount: number;
  maxWidth: number;
}

export function RepoNode({
  project,
  expanded,
  isSelected,
  isChildSelected,
  worktreeCount,
  maxWidth,
}: Props) {
  const arrow = expanded ? "▼" : "▶";
  const active = isSelected || isChildSelected;
  const prefix = isSelected ? "❯ " : "  ";
  // overhead: prefix (2) + arrow (1) + space (1) = 4
  const displayProject = truncateBranch(project, maxWidth - 4);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
        <Text color={isSelected ? "cyan" : "yellow"} bold={active}>
          {arrow} {displayProject}
        </Text>
      </Box>
      {expanded && worktreeCount === 0 ? (
        <Box>
          <Text>{"    "}</Text>
          <Text dimColor>(no worktrees)</Text>
        </Box>
      ) : null}
    </Box>
  );
}
```

- [ ] **Step 4: Run the RepoNode tests to confirm they pass**

```bash
bun run test tests/tui/repo-node.test.tsx
```

Expected: all 3 tests PASS

- [ ] **Step 5: Update `src/tui/components/TreeView.tsx`**

Pass `maxWidth` to the `RepoNode` call (around line 95–104). Add `maxWidth={maxWidth}` to the `<RepoNode ... />` JSX:

```tsx
elements.push(
  <RepoNode
    key={`repo-${repo.id}`}
    project={repo.project}
    expanded={expandedRepos.has(repo.id)}
    isSelected={idx === selectedIndex}
    isChildSelected={childSelected}
    worktreeCount={repo.worktrees.length}
    maxWidth={maxWidth}
  />,
);
```

- [ ] **Step 6: Run the full test suite to confirm no regressions**

```bash
bun run test
```

Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add tests/tui/repo-node.test.tsx src/tui/components/RepoNode.tsx \
        src/tui/components/TreeView.tsx
git commit -m "feat(tui): truncate project names in RepoNode to fit terminal width"
```

---

## Task 4: `DetailRow` truncation + TreeView wiring smoke test

**Files:**
- Modify: `src/tui/components/DetailRow.tsx`
- Modify: `src/tui/components/TreeView.tsx`
- Modify: `tests/tui/detail-row.test.tsx`
- Create: `tests/tui/tree-view-wiring.test.tsx`

- [ ] **Step 1: Write the failing DetailRow truncation tests**

Add the following tests to `tests/tui/detail-row.test.tsx` inside the existing `describe("DetailRow", ...)` block. The existing `renderDetailRow` helper already works via `React.ComponentProps<typeof DetailRow>` — once `maxWidth` is added to `DetailRow`'s `Props`, this helper will require it for all calls.

**Also update all existing `renderDetailRow` calls to include `maxWidth: 80`** (wide enough that existing tests are unaffected):

```tsx
// In the existing zoom indicator test, add maxWidth: 80 to each renderDetailRow call:
const zoomedActive = await renderDetailRow({
  item: { ... }, // unchanged
  isSelected: false,
  maxWidth: 80,  // ADD THIS
});
// same for zoomedInactive and unzoomedActive
```

**Add new test cases:**

```tsx
test("renders full pane label when width is sufficient", async () => {
  // overhead=10 (indent 8 + selectorPrefix 2), available=70, "1:0 vim" easily fits
  const { output, unmount } = await renderDetailRow({
    item: {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane",
      label: "1:0 vim",
      meta: {
        paneId: "%0",
        zoomed: false,
        active: false,
        window: "1",
        paneIndex: 0,
        command: "vim",
      },
    } as Extract<TreeItem, { type: "detail"; detailKind: "pane" }>,
    isSelected: false,
    maxWidth: 80,
  });
  expect(output).toContain("1:0 vim");
  unmount();
});

test("preserves window:index prefix when command is long", async () => {
  // overhead=10, maxWidth=20 → available=10
  // prefix "1:0 " (4), rest "bun run dev" (11)
  // 15 > 10, available(10) > prefix+3(7) → prefix + truncateBranch("bun run dev", 6)
  // → "1:0 " + "bun..." → "1:0 bun..."
  const { output, unmount } = await renderDetailRow({
    item: {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane",
      label: "1:0 bun run dev",
      meta: {
        paneId: "%0",
        zoomed: false,
        active: false,
        window: "1",
        paneIndex: 0,
        command: "bun run dev",
      },
    } as Extract<TreeItem, { type: "detail"; detailKind: "pane" }>,
    isSelected: false,
    maxWidth: 20,
  });
  expect(output).toContain("1:0 ");
  expect(output).toContain("bun...");
  expect(output).not.toContain("bun run dev");
  unmount();
});

test("truncates pane-header label when width is tight", async () => {
  // overhead=8 (indent 6 + selectorPrefix 2), maxWidth=15 → available=7
  // "Panes (3)" (9) → truncateBranch("Panes (3)", 7) → "Pane..."
  const { output, unmount } = await renderDetailRow({
    item: {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pane-header",
      label: "Panes (3)",
    } as Extract<TreeItem, { type: "detail"; detailKind: "pane-header" }>,
    isSelected: false,
    maxWidth: 15,
  });
  expect(output).toContain("Pane...");
  expect(output).not.toContain("Panes (3)");
  unmount();
});

test("truncates check label when width is tight", async () => {
  // overhead=12 (indent 8 + selectorPrefix 2 + icon 1 + space 1), maxWidth=20 → available=8
  // "ci/backend" (10) → truncateBranch("ci/backend", 8) → "ci/ba..."
  const { output, unmount } = await renderDetailRow({
    item: {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "check",
      label: "ci/backend",
      meta: { state: "success" },
    } as Extract<TreeItem, { type: "detail"; detailKind: "check" }>,
    isSelected: false,
    maxWidth: 20,
  });
  expect(output).toContain("ci/ba...");
  expect(output).not.toContain("ci/backend");
  unmount();
});
```

- [ ] **Step 2: Run the tests to confirm the new ones fail**

```bash
bun run test tests/tui/detail-row.test.tsx
```

Expected: new tests FAIL — `maxWidth` is not a valid prop; existing tests may fail due to missing `maxWidth` in `renderDetailRow` calls

- [ ] **Step 3: Update `src/tui/components/DetailRow.tsx`**

```tsx
import { Box, Text } from "ink";
import { truncateBranch, truncateWithPrefix } from "../utils/truncate";
import type { TreeItem } from "../types";
import { checkColor, checkIcon } from "../types";

interface Props {
  item: Extract<TreeItem, { type: "detail" }>;
  isSelected: boolean;
  maxWidth: number;
}

export function DetailRow({ item, isSelected, maxWidth }: Props) {
  const { detailKind, label } = item;
  const prefix = isSelected ? "▸ " : "  ";
  const indent =
    detailKind === "pr" || detailKind === "pane-header"
      ? "      " // 6 spaces
      : "        "; // 8 spaces

  switch (item.detailKind) {
    case "pane-header":
      // overhead: indent(6) + selectorPrefix(2) = 8
      return (
        <Box>
          <Text>{indent}</Text>
          <Text
            color={isSelected ? "cyan" : undefined}
            bold={isSelected}
            dimColor={!isSelected}
          >
            {prefix}
            {truncateBranch(label, maxWidth - 8)}
          </Text>
        </Box>
      );

    case "pr":
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
            {prefix}
            {label}
          </Text>
        </Box>
      );

    case "check": {
      const icon = checkIcon(item.meta.state ?? "");
      const color = checkColor(item.meta.state ?? "");
      // overhead: indent(8) + selectorPrefix(2) + icon(1) + space(1) = 12
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : "dim"} bold={isSelected}>
            {prefix}
          </Text>
          <Text color={color}>{icon}</Text>
          <Text color={isSelected ? "cyan" : "dim"} bold={isSelected}>
            {" "}
            {truncateBranch(label, maxWidth - 12)}
          </Text>
        </Box>
      );
    }

    case "pane": {
      const { window, paneIndex, command, zoomed, active } = item.meta;
      const zoomedEmoji = zoomed && active ? "🔍 " : "";
      // overhead: indent(8) + selectorPrefix(2) + zoomedEmoji(3 if shown, else 0)
      const overhead = 8 + 2 + (zoomedEmoji ? 3 : 0);
      const panePrefix = `${window}:${paneIndex} `;
      const displayLabel = truncateWithPrefix(panePrefix, command, maxWidth - overhead);
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : "dim"} bold={isSelected}>
            {prefix}
            {zoomedEmoji}
            {displayLabel}
          </Text>
        </Box>
      );
    }
  }
}
```

- [ ] **Step 4: Run the DetailRow tests to confirm they pass**

```bash
bun run test tests/tui/detail-row.test.tsx
```

Expected: all tests PASS

- [ ] **Step 5: Update `src/tui/components/TreeView.tsx`**

Pass `maxWidth` to the `<DetailRow ... />` call (around line 109–115):

```tsx
elements.push(
  <DetailRow
    key={getDetailRowKey(repo.id, item)}
    item={item}
    isSelected={idx === selectedIndex}
    maxWidth={maxWidth}
  />,
);
```

- [ ] **Step 6: Write the TreeView wiring smoke test**

Create `tests/tui/tree-view-wiring.test.tsx`:

```tsx
import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { buildTreeItems } from "../../src/tui/tree-helpers";
import { TreeView } from "../../src/tui/components/TreeView";

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 80;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

describe("TreeView maxWidth wiring", () => {
  test("passes maxWidth to RepoNode — long project name is truncated", async () => {
    const repos = [
      {
        id: "repo-1",
        repoPath: "/tmp/very-long-project-name",
        project: "very-long-project-name",
        worktrees: [],
        profileNames: [],
      },
    ];
    const expandedRepos = new Set(["repo-1"]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      prData: new Map(),
      panes: new Map(),
      jumpToPane: () => undefined,
    });

    const { stdout, stdin } = createStdoutStdin();
    const chunks: string[] = [];
    stdout.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });

    const { render } = await import("ink");
    const instance = render(
      React.createElement(TreeView, {
        repos,
        sessions: [],
        expandedRepos,
        selectedIndex: 0,
        items,
        pendingActions: new Map(),
        prData: new Map(),
        panes: new Map(),
        expandedWorktreeKey: null,
        maxWidth: 15,
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = chunks.join("");

    // "very-long-project-name" (22 chars) with maxWidth=15, overhead=4 → available=11
    // truncateBranch("very-long-project-name", 11) → "very-lon..."
    expect(output).toContain("very-lon...");
    expect(output).not.toContain("very-long-project-name");

    instance.unmount();
  });
});
```

- [ ] **Step 7: Run the wiring smoke test to confirm it passes**

```bash
bun run test tests/tui/tree-view-wiring.test.tsx
```

Expected: PASS

- [ ] **Step 8: Run the full test suite**

```bash
bun run test
```

Expected: all tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/tui/components/DetailRow.tsx src/tui/components/TreeView.tsx \
        tests/tui/detail-row.test.tsx tests/tui/tree-view-wiring.test.tsx
git commit -m "feat(tui): truncate pane/check/pane-header labels in DetailRow to fit terminal width"
```

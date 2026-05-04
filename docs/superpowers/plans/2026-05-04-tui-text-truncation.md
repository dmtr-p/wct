# TUI Text Truncation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Truncate project names in `RepoNode` and pane/check/pane-header labels in `DetailRow` to fit the terminal width, matching the existing branch-name truncation pattern.

**Architecture:** Extract `truncateBranch` from `WorktreeItem.tsx` into a shared `src/tui/utils/truncate.ts` alongside a new `truncateWithPrefix` helper. Tighten the `DetailItem` type so pane and check meta are always required. Thread `maxWidth` into `RepoNode` and `DetailRow` via `TreeView`.

**Tech Stack:** TypeScript, React/Ink (TUI), Vitest

> **Hooks note:** This repo runs `bun run test` and `biome lint/format` automatically via Claude Code Stop/PostToolUse hooks. **Do not run tests or lint manually.** Every commit in this plan is sufficient — the hooks verify correctness on stop.

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
| `tests/tui/build-tree-items.test.ts` | **Modify** — add missing pane meta fields; assert new fields |
| `tests/tui/detail-row.test.tsx` | **Modify** — add missing required meta fields; add truncation tests |
| `tests/tui/status-bar-wiring.test.ts` | **Modify** — add missing pane meta fields |
| `tests/tui/tree-view-keys.test.ts` | **Modify** — add missing pane meta fields |
| `tests/tui/adjust-index.test.ts` | **Modify** — add missing pane meta fields; add missing check meta |
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

- [ ] **Step 1: Create `tests/tui/truncate.test.ts`**

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

- [ ] **Step 2: Create `src/tui/utils/truncate.ts`**

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

- [ ] **Step 3: Update `src/tui/components/WorktreeItem.tsx`**

Add import at the top:

```ts
import { truncateBranch } from "../utils/truncate";
```

Remove the local `truncateBranch` definition (lines 17–21 — the exported function currently defined there):

```ts
// DELETE these lines:
export function truncateBranch(branch: string, available: number): string {
  if (branch.length <= available) return branch;
  if (available <= 3) return ".".repeat(Math.max(0, available));
  return `${branch.slice(0, available - 3)}...`;
}
```

`branchBudget` stays — it is only used inside `WorktreeItem.tsx`.

- [ ] **Step 4: Update `tests/tui/worktree-item.test.ts`**

Change the import:

```ts
// Before:
import { truncateBranch } from "../../src/tui/components/WorktreeItem";

// After:
import { truncateBranch } from "../../src/tui/utils/truncate";
```

- [ ] **Step 5: Commit**

```bash
git add src/tui/utils/truncate.ts tests/tui/truncate.test.ts \
        src/tui/components/WorktreeItem.tsx tests/tui/worktree-item.test.ts
git commit -m "refactor(tui): extract truncation helpers to shared utility"
```

---

## Task 2: Tighten `DetailItem` type and update all affected fixtures

This task makes `meta` required for metadata-bearing detail items (`"check"` and `"pane"`) and extends the pane meta shape. The type change will not cause TypeScript compile errors in test files that use `as TreeItem` casts, but the fixtures must be updated for correctness and to avoid runtime failures.

**Files:**
- Modify: `src/tui/types.ts`
- Modify: `src/tui/tree-helpers.ts`
- Modify: `tests/tui/build-tree-items.test.ts`
- Modify: `tests/tui/detail-row.test.tsx`
- Modify: `tests/tui/status-bar-wiring.test.ts`
- Modify: `tests/tui/tree-view-keys.test.ts`
- Modify: `tests/tui/adjust-index.test.ts`

- [ ] **Step 1: Update `src/tui/types.ts` — make meta required**

In the `DetailItem` generic (around line 134), change `meta?: TMeta` to `meta: TMeta`:

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

This makes `meta` required for both `"check"` and `"pane"` detail items (the two kinds that supply a `TMeta` argument). `"pr"` and `"pane-header"` use the `TMeta = undefined` branch and are unaffected.

- [ ] **Step 2: Update `src/tui/types.ts` — extend pane meta shape**

Update the `"pane"` union member to include the three new required fields:

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

- [ ] **Step 3: Update `src/tui/tree-helpers.ts` — set new meta fields**

In the pane-building loop (around line 148–161), add `window`, `paneIndex`, and `command` to `meta`:

```ts
// Before:
meta: {
  paneId: pane.paneId,
  zoomed: pane.zoomed,
  active: pane.active,
},

// After:
meta: {
  paneId: pane.paneId,
  zoomed: pane.zoomed,
  active: pane.active,
  window: pane.window,
  paneIndex: pane.paneIndex,
  command: pane.command,
},
```

- [ ] **Step 4: Update `tests/tui/build-tree-items.test.ts`**

**4a.** Extend the first test ("passes zoomed and active pane metadata") to also assert the three new fields. Find the assertion block (after `buildTreeItems(...)`) and add:

```ts
const paneItem = items.find(
  (i) => i.type === "detail" && i.detailKind === "pane",
) as Extract<TreeItem, { type: "detail"; detailKind: "pane" }> | undefined;

expect(paneItem).toBeDefined();
expect(paneItem!.meta.window).toBe("main");
expect(paneItem!.meta.paneIndex).toBe(0);
expect(paneItem!.meta.command).toBe("bun run dev");
```

**4b.** In the "resolves the correct pane when multiple pane rows share the same label" test (around line 174–184), the two manually constructed pane items need the new fields. The adjacent `panes` fixture at line 207 has the ground-truth values (`%1 → paneIndex: 0, command: "bash"` and `%2 → paneIndex: 1, command: "top"`):

```ts
// Line ~174 — pane item for %1:
meta: { paneId: "%1", zoomed: false, active: false, window: "main", paneIndex: 0, command: "bash" },

// Line ~182 — pane item for %2:
meta: { paneId: "%2", zoomed: true, active: true, window: "main", paneIndex: 1, command: "top" },
```

**4c.** In the "finds the owning worktree row for a selected detail row" test (around line 251), derive values from the label `"editor:0 bash"`:

```ts
meta: { paneId: "%1", zoomed: false, active: true, window: "editor", paneIndex: 0, command: "bash" },
```

- [ ] **Step 5: Update `tests/tui/detail-row.test.tsx`**

The three pane item objects in the existing zoom indicator test need all required fields. Derive `window`, `paneIndex`, `command` from the labels:

```ts
// Pane with label "main:0 bash" (zoomed, active):
meta: { paneId: "%0", zoomed: true, active: true, window: "main", paneIndex: 0, command: "bash" },

// Pane with label "main:1 node" (zoomed, not active):
meta: { paneId: "%1", zoomed: true, active: false, window: "main", paneIndex: 1, command: "node" },

// Pane with label "main:2 zsh" (not zoomed, active):
meta: { paneId: "%2", zoomed: false, active: true, window: "main", paneIndex: 2, command: "zsh" },
```

- [ ] **Step 6: Update `tests/tui/status-bar-wiring.test.ts`**

There are two pane items (around lines 13 and 61), both with `label: "main:0 bash"`. Add the three new fields to each:

```ts
meta: { paneId: "%1", zoomed: false, active: true, window: "main", paneIndex: 0, command: "bash" },
```

- [ ] **Step 7: Update `tests/tui/tree-view-keys.test.ts`**

There are two pane items (around lines 11 and 19), both with `label: "main:0 bash"`. Add the three new fields to each, deriving from the label:

```ts
// paneA (paneId "%1"):
meta: { paneId: "%1", zoomed: false, active: false, window: "main", paneIndex: 0, command: "bash" },

// paneB (paneId "%2"):
meta: { paneId: "%2", zoomed: true, active: true, window: "main", paneIndex: 0, command: "bash" },
```

- [ ] **Step 8: Update `tests/tui/adjust-index.test.ts` — pane items**

There are four pane item constructions. Add the three new fields to each, derived from their labels:

```ts
// Line ~154 — label "main:0 bash", paneId "%1":
meta: { paneId: "%1", zoomed: false, active: false, window: "main", paneIndex: 0, command: "bash" },

// Line ~162 — label "main:1 bash", paneId "%2":
meta: { paneId: "%2", zoomed: false, active: true, window: "main", paneIndex: 1, command: "bash" },

// Line ~243 — label "main:0 bash", paneId "%1":
meta: { paneId: "%1", zoomed: false, active: false, window: "main", paneIndex: 0, command: "bash" },

// Line ~251 — label "main:1 vim", paneId "%2":
meta: { paneId: "%2", zoomed: false, active: true, window: "main", paneIndex: 1, command: "vim" },
```

- [ ] **Step 9: Update `tests/tui/adjust-index.test.ts` — check items**

There are two check items (around lines 130 and 137) with no `meta` field. After the generic change, `"check"` items require `meta: { state?: string }`. Add `meta: {}` to each (since `state` is optional within the meta object):

```ts
// checkA (line ~130):
{
  type: "detail",
  repoIndex: 0,
  worktreeIndex: 0,
  detailKind: "check",
  label: "CI / build",
  meta: {},
} as TreeItem,

// checkB (line ~137):
{
  type: "detail",
  repoIndex: 0,
  worktreeIndex: 0,
  detailKind: "check",
  label: "CI / lint",
  meta: {},
} as TreeItem,
```

- [ ] **Step 10: Commit**

```bash
git add src/tui/types.ts src/tui/tree-helpers.ts \
        tests/tui/build-tree-items.test.ts tests/tui/detail-row.test.tsx \
        tests/tui/status-bar-wiring.test.ts tests/tui/tree-view-keys.test.ts \
        tests/tui/adjust-index.test.ts
git commit -m "feat(tui): tighten DetailItem type — meta required for check/pane, extend pane meta"
```

---

## Task 3: `RepoNode` project name truncation

**Files:**
- Create: `tests/tui/repo-node.test.tsx`
- Modify: `src/tui/components/RepoNode.tsx`
- Modify: `src/tui/components/TreeView.tsx`

- [ ] **Step 1: Create `tests/tui/repo-node.test.tsx`**

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

  test("renders full name at exact available width", async () => {
    // overhead=4, project="my-project" (10), maxWidth=14 → available=10 → fits exactly
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

- [ ] **Step 2: Update `src/tui/components/RepoNode.tsx`**

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

- [ ] **Step 3: Update `src/tui/components/TreeView.tsx` — pass `maxWidth` to `RepoNode`**

Add `maxWidth={maxWidth}` to the `<RepoNode ... />` JSX (around line 95–104):

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

- [ ] **Step 4: Commit**

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

- [ ] **Step 1: Update `tests/tui/detail-row.test.tsx` — add `maxWidth` to existing calls and new truncation tests**

**1a.** The `renderDetailRow` helper picks up `React.ComponentProps<typeof DetailRow>` — once `maxWidth` is added to `DetailRow`'s `Props` in Step 2 it will be required. Update all three existing `renderDetailRow` calls in the zoom indicator test to pass `maxWidth: 80`:

```tsx
const zoomedActive = await renderDetailRow({
  item: { ... }, // unchanged
  isSelected: false,
  maxWidth: 80,
});
// same for zoomedInactive and unzoomedActive
```

**1b.** Add these test cases inside the existing `describe("DetailRow", ...)` block:

```tsx
test("renders full pane label when width is sufficient", async () => {
  // overhead=10, available=70, "1:0 vim" (7) fits
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
  // overhead=10 (indent 8 + selectorPrefix 2), maxWidth=20 → available=10
  // prefix "1:0 " (4), rest "bun run dev" (11)
  // 15 > 10, available(10) > prefix+3(7) → "1:0 " + truncateBranch("bun run dev", 6)
  // → "1:0 bun..."
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
  // "Panes (3)" (9) → "Pane..."
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
  // "ci/backend" (10) → "ci/ba..."
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

- [ ] **Step 2: Update `src/tui/components/DetailRow.tsx`**

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
      const displayLabel = truncateWithPrefix(
        panePrefix,
        command,
        maxWidth - overhead,
      );
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

- [ ] **Step 3: Update `src/tui/components/TreeView.tsx` — pass `maxWidth` to `DetailRow`**

Add `maxWidth={maxWidth}` to the `<DetailRow ... />` JSX (around line 109–115):

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

- [ ] **Step 4: Create `tests/tui/tree-view-wiring.test.tsx`**

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

    // "very-long-project-name" (22 chars), maxWidth=15, overhead=4 → available=11
    // truncateBranch("very-long-project-name", 11) → "very-lon..."
    expect(output).toContain("very-lon...");
    expect(output).not.toContain("very-long-project-name");

    instance.unmount();
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/DetailRow.tsx src/tui/components/TreeView.tsx \
        tests/tui/detail-row.test.tsx tests/tui/tree-view-wiring.test.tsx
git commit -m "feat(tui): truncate pane/check/pane-header labels in DetailRow to fit terminal width"
```

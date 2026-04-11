# Open Modal Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the TUI open worktree modal with lazygit-inspired rounded boxes that embed titles in the top border.

**Architecture:** A new `TitledBox` component renders `╭ Title ───╮ │ content │ ╰──────────╯` using a hybrid approach: the top and bottom borders are rendered manually with `Text` nodes (to embed the title), while the side borders use Ink's native `Box` with `borderStyle="round"` and `borderTop: false, borderBottom: false` (to correctly handle multiline content). All modal sub-components (`BracketInput`, `PromptArea`, `ModeSelector`, `ScrollableList` wrappers, and the outer `Modal`) switch to using `TitledBox`.

**Tech Stack:** React, Ink, TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-04-11-open-modal-restyle-design.md`

---

### Task 1: Create `TitledBox` component with tests

**Files:**
- Create: `src/tui/components/TitledBox.tsx`
- Create: `tests/tui/titled-box.test.tsx`

- [ ] **Step 1: Write the `TitledBox` rendering tests**

Uses the same PassThrough-based Ink render pattern as existing TUI tests (see `tests/tui/detail-row.test.tsx` for reference).

```tsx
// tests/tui/titled-box.test.tsx
import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { TitledBox } from "../../src/tui/components/TitledBox";

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 60;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

async function renderTitledBox(props: React.ComponentProps<typeof TitledBox>) {
  const { stdout, stdin } = createStdoutStdin();
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  const { render } = await import("ink");
  const { Text } = await import("ink");
  const instance = render(React.createElement(TitledBox, props), {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
  });
  await new Promise((r) => setTimeout(r, 50));
  instance.unmount();
  // Strip ANSI escape codes for assertion
  return chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("TitledBox", () => {
  test("renders top border with embedded title", async () => {
    const { Text } = await import("ink");
    const frame = await renderTitledBox({
      title: "Branch",
      isFocused: true,
      width: 24,
      children: React.createElement(Text, {}, "my-feature"),
    });
    const lines = frame.split("\n");
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("Branch");
    expect(lines[0]).toContain("╮");
  });

  test("renders bottom border", async () => {
    const { Text } = await import("ink");
    const frame = await renderTitledBox({
      title: "Test",
      isFocused: false,
      width: 24,
      children: React.createElement(Text, {}, "content"),
    });
    const lines = frame.split("\n").filter((l) => l.trim());
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain("╰");
    expect(lastLine).toContain("╯");
  });

  test("renders children between borders", async () => {
    const { Text } = await import("ink");
    const frame = await renderTitledBox({
      title: "Test",
      isFocused: true,
      width: 24,
      children: React.createElement(Text, {}, "hello world"),
    });
    expect(frame).toContain("hello world");
  });

  test("truncates title with ellipsis when wider than box", async () => {
    const { Text } = await import("ink");
    const frame = await renderTitledBox({
      title: "Open Worktree — Existing Branch",
      isFocused: true,
      width: 30,
      children: React.createElement(Text, {}, "content"),
    });
    const lines = frame.split("\n").filter((l) => l.trim());
    const topLine = lines[0];
    // Top border must not exceed requested width
    // Strip ANSI codes already done in renderTitledBox
    expect(topLine).toContain("…");
    expect(topLine).toContain("╭");
    expect(topLine).toContain("╮");
  });

  test("all border lines stay within requested width", async () => {
    const { Text } = await import("ink");
    const width = 30;
    const frame = await renderTitledBox({
      title: "A Very Long Title That Overflows",
      isFocused: true,
      width,
      children: React.createElement(Text, {}, "content"),
    });
    const lines = frame.split("\n").filter((l) => l.trim());
    const topLine = lines[0];
    const bottomLine = lines[lines.length - 1];
    // Verify border lines don't exceed the requested width
    expect(topLine.length).toBeLessThanOrEqual(width);
    expect(bottomLine.length).toBeLessThanOrEqual(width);
  });

  test("renders side borders for every line of multiline content", async () => {
    const { Text, Box } = await import("ink");
    const frame = await renderTitledBox({
      title: "Prompt",
      isFocused: true,
      width: 30,
      children: React.createElement(
        Box,
        { flexDirection: "column" },
        React.createElement(Text, {}, "line one"),
        React.createElement(Text, {}, "line two"),
        React.createElement(Text, {}, "line three"),
      ),
    });
    const lines = frame.split("\n").filter((l) => l.trim());
    // Lines 1, 2, 3 (between top and bottom border) should all have │
    const contentLines = lines.slice(1, -1);
    expect(contentLines.length).toBeGreaterThanOrEqual(3);
    for (const line of contentLines) {
      expect(line).toContain("│");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/tui/titled-box.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `TitledBox`**

Uses a hybrid approach: manual top/bottom borders (to embed the title) + Ink's native `Box` with `borderStyle="round"` and per-side border toggles for the side borders. This ensures multiline content is correctly enclosed — Ink handles the `│` on every content line automatically.

```tsx
// src/tui/components/TitledBox.tsx
import { Box, Text } from "ink";
import type { ReactNode } from "react";

interface Props {
  title: string;
  isFocused: boolean;
  width?: number;
  children: ReactNode;
}

export function TitledBox({ title, isFocused, width = 40, children }: Props) {
  const color = isFocused ? "cyan" : undefined;
  const dimColor = !isFocused;

  // Truncate title with ellipsis if it won't fit in the requested width.
  // Top border layout: "╭ " + title + " " + dashes + "╮" → title can use at most width - 4 chars.
  const maxTitleLen = Math.max(0, width - 4);
  const displayTitle =
    title.length > maxTitleLen
      ? title.slice(0, Math.max(0, maxTitleLen - 1)) + "…"
      : title;

  const dashCount = Math.max(0, width - displayTitle.length - 4);
  const topBorder = `╭ ${displayTitle} ${"─".repeat(dashCount)}╮`;
  const bottomBorder = `╰${"─".repeat(width - 2)}╯`;

  return (
    <Box flexDirection="column">
      <Text color={color} dimColor={dimColor} bold={isFocused}>
        {topBorder}
      </Text>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={isFocused ? "cyan" : undefined}
        borderDimColor={!isFocused}
        borderTop={false}
        borderBottom={false}
        width={width}
      >
        {children}
      </Box>
      <Text color={color} dimColor={dimColor}>
        {bottomBorder}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test tests/tui/titled-box.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/TitledBox.tsx tests/tui/titled-box.test.tsx
git commit -m "feat(tui): add TitledBox component with lazygit-inspired border style"
```

---

### Task 2: Replace `Modal.tsx` to use `TitledBox`

**Files:**
- Modify: `src/tui/components/Modal.tsx`

- [ ] **Step 1: Update `Modal` to use `TitledBox` instead of Ink's `Box` border**

Replace the entire content of `Modal.tsx`:

```tsx
// src/tui/components/Modal.tsx
import type { ReactNode } from "react";
import { TitledBox } from "./TitledBox";

interface Props {
  title: string;
  children: ReactNode;
  visible: boolean;
  width?: number;
}

export function Modal({ title, children, visible, width }: Props) {
  if (!visible) return null;

  return (
    <TitledBox title={title} isFocused={true} width={width}>
      {children}
    </TitledBox>
  );
}
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `bun run test`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/Modal.tsx
git commit -m "refactor(tui): switch Modal to TitledBox"
```

---

### Task 3: Replace `BracketInput` with `TitledBox`-based input

**Files:**
- Modify: `src/tui/components/OpenModal.tsx` (the `BracketInput` sub-component)

- [ ] **Step 1: Replace the `BracketInput` component**

In `src/tui/components/OpenModal.tsx`, replace the `BracketInput` function (lines 76–114) with:

```tsx
function BracketInput({
  label,
  value,
  isFocused,
  onChange,
}: {
  label: string;
  value: string;
  isFocused: boolean;
  onChange: (v: string) => void;
}) {
  const cursorVisible = useBlink();

  useInput(
    (input, key) => {
      if (!isFocused) return;
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && !key.return) {
        onChange(value + input);
      }
    },
    { isActive: isFocused },
  );

  return (
    <TitledBox title={label} isFocused={isFocused}>
      <Text color={isFocused ? undefined : "dim"}>
        {value}
        {isFocused && cursorVisible ? "▎" : ""}
      </Text>
    </TitledBox>
  );
}
```

Add the import at the top of `OpenModal.tsx`:

```tsx
import { TitledBox } from "./TitledBox";
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `bun run test`
Expected: All existing tests pass

- [ ] **Step 3: Visually verify in TUI**

Run: `bun run src/index.ts tui`, press `o`, select "New Branch", and confirm the Branch and Base fields render with `╭ Branch ───╮` style boxes instead of `[ value ]` brackets.

- [ ] **Step 4: Commit**

```bash
git add src/tui/components/OpenModal.tsx
git commit -m "refactor(tui): replace BracketInput with TitledBox style"
```

---

### Task 4: Replace `PromptArea` with `TitledBox`-based textarea

**Files:**
- Modify: `src/tui/components/OpenModal.tsx` (the `PromptArea` sub-component)

- [ ] **Step 1: Replace the `PromptArea` component**

In `src/tui/components/OpenModal.tsx`, replace the `PromptArea` function (lines 116–154) with:

```tsx
function PromptArea({
  value,
  isFocused,
  onChange,
}: {
  value: string;
  isFocused: boolean;
  onChange: (v: string) => void;
}) {
  const cursorVisible = useBlink();

  useInput(
    (input, key) => {
      if (!isFocused) return;
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
      } else if (key.return) {
        onChange(`${value}\n`);
      } else if (input && !key.ctrl && !key.meta) {
        onChange(value + input);
      }
    },
    { isActive: isFocused },
  );

  return (
    <TitledBox title="Prompt" isFocused={isFocused}>
      <Text color={isFocused ? undefined : "dim"}>
        {value || (isFocused ? "" : "optional")}
        {isFocused ? (cursorVisible ? "▎" : " ") : ""}
      </Text>
    </TitledBox>
  );
}
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `bun run test`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/OpenModal.tsx
git commit -m "refactor(tui): replace PromptArea with TitledBox style"
```

---

### Task 5: Wrap `ModeSelector` options in `TitledBox`

**Files:**
- Modify: `src/tui/components/OpenModal.tsx` (the `ModeSelector` sub-component)

- [ ] **Step 1: Wrap the mode selector list in a `TitledBox`**

In `src/tui/components/OpenModal.tsx`, update the `ModeSelector` return JSX (lines 62–73) to:

```tsx
  return (
    <TitledBox title="Select mode" isFocused={true}>
      {options.map((opt, i) => {
        const isSel = i === selected;
        return (
          <Text key={opt.step} color={isSel ? "cyan" : "dim"} bold={isSel}>
            {isSel ? "▸ " : "  "}
            {opt.label}
          </Text>
        );
      })}
    </TitledBox>
  );
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `bun run test`
Expected: All existing tests pass

- [ ] **Step 3: Visually verify in TUI**

Run: `bun run src/index.ts tui`, press `o`, and confirm the mode selector renders inside a `╭ Select mode ───╮` box.

- [ ] **Step 4: Commit**

```bash
git add src/tui/components/OpenModal.tsx
git commit -m "refactor(tui): wrap ModeSelector in TitledBox"
```

---

### Task 6: Wrap `ScrollableList` in `TitledBox` and truncate long items

**Files:**
- Modify: `src/tui/components/ScrollableList.tsx`
- Modify: `src/tui/components/OpenModal.tsx` (the `FromPRForm` and `ExistingBranchForm` sub-components)

- [ ] **Step 1: Add `wrap="truncate"` to ScrollableList item labels**

In `src/tui/components/ScrollableList.tsx`, update the item rendering (lines 72–87) to use Ink's `wrap="truncate"` on the `Text` nodes so that long PR titles and branch names are truncated to a single line instead of wrapping. Replace the `{visible.map(...)` block:

```tsx
      {visible.map((item, i) => {
        const actualIndex = start + i;
        const isSelected = actualIndex === selectedIndex;
        return (
          <Box key={item.value}>
            <Text color={isSelected && isFocused ? "cyan" : undefined}>
              {isSelected ? "▸ " : "  "}
            </Text>
            <Text bold={isSelected} color={isSelected ? undefined : "dim"} wrap="truncate">
              {item.label}
            </Text>
            {item.description && <Text dimColor wrap="truncate"> {item.description}</Text>}
          </Box>
        );
      })}
```

- [ ] **Step 2: Run existing ScrollableList tests**

Run: `bun run test tests/tui/scrollable-list.test.ts`
Expected: All pass (tests are for `filterItems`/`getVisibleWindow`, not rendering)

- [ ] **Step 3: Commit truncation fix**

```bash
git add src/tui/components/ScrollableList.tsx
git commit -m "fix(tui): truncate long items in ScrollableList to prevent line wrapping"
```

- [ ] **Step 4: Wrap the PR list in `FromPRForm` with `TitledBox`**

In `FromPRForm`, replace the separate `<Text>Select PR</Text>` label and bare `<ScrollableList>` (lines 441–452) with:

```tsx
      <TitledBox title="Select PR" isFocused={currentField === "prList"}>
        <ScrollableList
          items={prItems}
          selectedIndex={selectedPRIndex}
          filterQuery={filterQuery}
          maxVisible={8}
          isFocused={currentField === "prList"}
        />
      </TitledBox>
```

Remove the standalone `<Text>Select PR</Text>` label since the title is now in the box border.

- [ ] **Step 5: Wrap the branch list in `ExistingBranchForm` with `TitledBox`**

In `ExistingBranchForm`, replace the separate `<Text>Select Branch</Text>` label and bare `<ScrollableList>` (lines 609–619) with:

```tsx
      <TitledBox title="Select Branch" isFocused={currentField === "branchList"}>
        <ScrollableList
          items={branchItems}
          selectedIndex={selectedBranchIndex}
          filterQuery={filterQuery}
          maxVisible={10}
          isFocused={currentField === "branchList"}
        />
      </TitledBox>
```

Remove the standalone `<Text>Select Branch</Text>` label.

- [ ] **Step 6: Run tests to verify nothing broke**

Run: `bun run test`
Expected: All existing tests pass

- [ ] **Step 7: Visually verify in TUI**

Run: `bun run src/index.ts tui`, press `o`, select "From PR" and "Existing Branch" modes, and confirm the select lists render inside titled boxes with long items truncated.

- [ ] **Step 8: Commit**

```bash
git add src/tui/components/OpenModal.tsx
git commit -m "refactor(tui): wrap ScrollableList in TitledBox for PR and branch selects"
```

---

### Task 7: Final visual polish and width consistency

**Files:**
- Modify: `src/tui/components/OpenModal.tsx`
- Modify: `src/tui/components/TitledBox.tsx` (if width adjustments needed)

- [ ] **Step 1: Ensure consistent width across all modal forms**

In the `OpenModal` component, pass a `width` prop to the outer `Modal` that uses the terminal width (or a sensible max). In `App.tsx`, `termCols` is already available. The `OpenModal` component should accept and forward a width prop.

Add `width?: number` to `OpenModalProps`:

```tsx
export interface OpenModalProps {
  visible: boolean;
  onSubmit: (result: OpenModalResult) => void;
  onCancel: () => void;
  defaultBase: string;
  profileNames: string[];
  repoProject: string;
  repoPath: string;
  prList: PRInfo[];
  width?: number;
}
```

In the `OpenModal` function, forward it to `Modal`:

```tsx
  return (
    <Modal title={titleMap[step]} visible={visible} width={width}>
```

In `App.tsx`, pass `width={Math.min(termCols, 60)}` to `OpenModal`. The longest modal title is "Open Worktree — Existing Branch" (31 chars), which needs `width >= 35` to render without truncation. 60 gives comfortable padding for inner content:

```tsx
        <OpenModal
          visible
          width={Math.min(termCols, 60)}
          // ... rest of props
        />
```

- [ ] **Step 2: Run the TUI and verify all forms look consistent**

Run: `bun run src/index.ts tui`, press `o`, cycle through all three modes. Confirm:
- Outer modal has consistent width
- Inner titled boxes fit within the outer box
- No text overflow or misaligned borders

- [ ] **Step 3: Run all tests**

Run: `bun run test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/tui/components/OpenModal.tsx src/tui/components/TitledBox.tsx src/tui/App.tsx
git commit -m "refactor(tui): consistent width for open modal boxes"
```

# Open Modal Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the TUI open worktree modal with lazygit-inspired rounded boxes that embed titles in the top border.

**Architecture:** A new `TitledBox` component renders `╭ Title ───╮ │ content │ ╰──────────╯` using box-drawing characters and Ink `Text` nodes. All modal sub-components (`BracketInput`, `PromptArea`, `ModeSelector`, `ScrollableList` wrappers, and the outer `Modal`) switch to using `TitledBox` instead of Ink's built-in border or manual bracket/separator styles.

**Tech Stack:** React, Ink, TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-04-11-open-modal-restyle-design.md`

---

### Task 1: Create `TitledBox` component with tests

**Files:**
- Create: `src/tui/components/TitledBox.tsx`
- Create: `tests/tui/titled-box.test.tsx`

- [ ] **Step 1: Write the `TitledBox` rendering tests**

```tsx
// tests/tui/titled-box.test.tsx
import { render } from "ink-testing-library";
import { Text } from "ink";
import { describe, expect, test } from "vitest";
import { TitledBox } from "../../src/tui/components/TitledBox";

describe("TitledBox", () => {
  test("renders top border with embedded title", () => {
    const { lastFrame } = render(
      <TitledBox title="Branch" isFocused={true} width={24}>
        <Text>my-feature</Text>
      </TitledBox>,
    );
    const frame = lastFrame()!;
    const lines = frame.split("\n");
    // Top border should contain the title
    expect(lines[0]).toContain("Branch");
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("╮");
  });

  test("renders bottom border", () => {
    const { lastFrame } = render(
      <TitledBox title="Test" isFocused={false} width={24}>
        <Text>content</Text>
      </TitledBox>,
    );
    const frame = lastFrame()!;
    const lines = frame.split("\n");
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain("╰");
    expect(lastLine).toContain("╯");
  });

  test("renders children between borders", () => {
    const { lastFrame } = render(
      <TitledBox title="Test" isFocused={true} width={24}>
        <Text>hello world</Text>
      </TitledBox>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("hello world");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/tui/titled-box.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `TitledBox`**

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

export function TitledBox({ title, isFocused, width = 30, children }: Props) {
  const color = isFocused ? "cyan" : undefined;
  const dimColor = !isFocused;
  const innerWidth = width - 2;
  const dashCount = Math.max(0, innerWidth - title.length - 2);
  const topBorder = `╭ ${title} ${"─".repeat(dashCount)}╮`;
  const bottomBorder = `╰${"─".repeat(innerWidth)}╯`;

  return (
    <Box flexDirection="column">
      <Text color={color} dimColor={dimColor} bold={isFocused}>
        {topBorder}
      </Text>
      <Box>
        <Text color={color} dimColor={dimColor}>│ </Text>
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
        <Text color={color} dimColor={dimColor}> │</Text>
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

### Task 6: Wrap `ScrollableList` in `TitledBox` for PR and Branch select forms

**Files:**
- Modify: `src/tui/components/OpenModal.tsx` (the `FromPRForm` and `ExistingBranchForm` sub-components)

- [ ] **Step 1: Wrap the PR list in `FromPRForm` with `TitledBox`**

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

- [ ] **Step 2: Wrap the branch list in `ExistingBranchForm` with `TitledBox`**

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

- [ ] **Step 3: Run tests to verify nothing broke**

Run: `bun run test`
Expected: All existing tests pass

- [ ] **Step 4: Visually verify in TUI**

Run: `bun run src/index.ts tui`, press `o`, select "From PR" and "Existing Branch" modes, and confirm the select lists render inside titled boxes.

- [ ] **Step 5: Commit**

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

In `App.tsx`, pass `width={Math.min(termCols, 50)}` to `OpenModal`:

```tsx
        <OpenModal
          visible
          width={Math.min(termCols, 50)}
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

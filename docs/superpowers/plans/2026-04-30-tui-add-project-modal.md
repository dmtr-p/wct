# TUI Add Project Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Add Project" modal to the TUI so users can register new repos without leaving the TUI.

**Architecture:** A new `AddProjectModal` component with a custom `PathInput` that provides filesystem completion. Integrated via a new `AddProjectModal` mode, keybinding `a` in Navigate/Expanded modes, and `handleAddProject` in `useModalActions`.

**Tech Stack:** React/Ink, Effect, vitest

---

### Task 1: Add `AddProjectModal` mode to types

**Files:**
- Modify: `src/tui/types.ts:6-48`
- Test: `tests/tui/types.test.ts`

- [ ] **Step 1: Add the new mode variant**

In `src/tui/types.ts`, add `AddProjectModal` to the `Mode` union type:

```typescript
export type Mode =
  | { type: "Navigate" }
  | { type: "Search" }
  | { type: "OpenModal" }
  | { type: "AddProjectModal" }  // ← add this line
  | {
      type: "UpModal";
      // ... rest unchanged
```

- [ ] **Step 2: Add the Mode constructor**

In the `Mode` namespace object (line 50), add:

```typescript
export const Mode = {
  Navigate: { type: "Navigate" } as Mode,
  Search: { type: "Search" } as Mode,
  OpenModal: { type: "OpenModal" } as Mode,
  AddProjectModal: { type: "AddProjectModal" } as Mode,  // ← add this line
  // ... rest unchanged
```

- [ ] **Step 3: Run tests**

Run: `bun run test`
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/tui/types.ts
git commit -m "feat(tui): add AddProjectModal mode variant"
```

---

### Task 2: Add `a` keybinding to navigate and expanded input handlers

**Files:**
- Modify: `src/tui/input/navigate.ts:1-103`
- Modify: `src/tui/App.tsx:407-440` (useInput handler — add `AddProjectModal` to quit-blocker and switch case)
- Modify: `src/tui/components/StatusBar.tsx:21-71` (add `a:add` hint)
- Test: `tests/tui/input-navigate.test.ts`
- Test: `tests/tui/status-bar.test.tsx`

- [ ] **Step 1: Write the failing test for `a` keybinding**

Add to `tests/tui/input-navigate.test.ts`:

```typescript
test("a calls prepareAddProjectModal", () => {
  const ctx = makeCtx();
  handleNavigateInput(ctx, "a", noKey);
  expect(ctx.prepareAddProjectModal).toHaveBeenCalled();
});
```

Update `makeCtx` to include `prepareAddProjectModal: vi.fn()`:

```typescript
function makeCtx(overrides?: Partial<NavigateContext>): NavigateContext {
  return {
    // ... existing fields ...
    prepareAddProjectModal: vi.fn(),
    ...overrides,
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/tui/input-navigate.test.ts`
Expected: FAIL — `prepareAddProjectModal` not in `NavigateContext`

- [ ] **Step 3: Add `prepareAddProjectModal` to NavigateContext and handler**

In `src/tui/input/navigate.ts`, add to the `NavigateContext` interface:

```typescript
export interface NavigateContext {
  // ... existing fields ...
  prepareAddProjectModal: () => void;
}
```

Add the handler in `handleNavigateInput`, after the `u` handler (line 54):

```typescript
if (input === "a") {
  ctx.prepareAddProjectModal();
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test tests/tui/input-navigate.test.ts`
Expected: PASS

- [ ] **Step 5: Update App.tsx useInput handler**

In `src/tui/App.tsx`, add `AddProjectModal` to the quit-blocker condition (line 410):

```typescript
input === "q" &&
  mode.type !== "OpenModal" &&
  mode.type !== "UpModal" &&
  mode.type !== "AddProjectModal" &&  // ← add this line
  mode.type !== "Search" &&
  // ...
```

Add `AddProjectModal` to the switch case alongside other modals (line 427):

```typescript
case "OpenModal":
case "UpModal":
case "AddProjectModal":  // ← add this line
  return;
```

Wire `prepareAddProjectModal` into the `navCtx` object that is passed to `handleNavigateInput`. Find where `navCtx` is constructed (search for `prepareOpenModal` in App.tsx) and add `prepareAddProjectModal` from `modalActions`:

```typescript
const navCtx = {
  // ... existing fields ...
  prepareAddProjectModal: modalActions.prepareAddProjectModal,
};
```

`expCtx` spreads `navCtx`, so no separate wiring needed there.

- [ ] **Step 6: Update StatusBar hints**

In `src/tui/components/StatusBar.tsx`, add `a:add` to Navigate and Expanded hints.

Navigate mode (line 28):
```typescript
return [
  join(
    "↑↓:navigate",
    "←→:expand/collapse",
    hasClient && "space:switch",
    "o:open",
    "a:add",
  ),
  join("u:up", hasClient && "d:down", "c:close", "/:search", "q:quit"),
];
```

Expanded mode non-pane (line 54):
```typescript
return [
  join(
    "↑↓:navigate",
    "←:collapse",
    hasClient && "space:action",
    "o:open",
    "a:add",
  ),
  join("u:up", hasClient && "d:down", "c:close", "/:search", "q:quit"),
];
```

- [ ] **Step 7: Run all tests**

Run: `bun run test`
Expected: All pass (App.tsx may have compile errors until Task 4 wires modalActions — fix by adding a stub `prepareAddProjectModal: () => {}` temporarily if needed).

- [ ] **Step 8: Commit**

```bash
git add src/tui/input/navigate.ts src/tui/App.tsx src/tui/components/StatusBar.tsx tests/tui/input-navigate.test.ts
git commit -m "feat(tui): add 'a' keybinding for add project modal"
```

---

### Task 3: Create `PathInput` component

**Files:**
- Create: `src/tui/components/PathInput.tsx`
- Test: `tests/tui/path-input.test.tsx`

- [ ] **Step 1: Write tests for PathInput**

Create `tests/tui/path-input.test.tsx`:

```typescript
import { describe, expect, test, vi } from "vitest";
import { expandTilde, getParentAndPrefix } from "../../src/tui/components/PathInput";

describe("getParentAndPrefix", () => {
  test("splits /Users/dmtr/co into parent=/Users/dmtr/ prefix=co", () => {
    expect(getParentAndPrefix("/Users/dmtr/co")).toEqual({
      parent: "/Users/dmtr/",
      prefix: "co",
    });
  });

  test("splits /Users/dmtr/ into parent=/Users/dmtr/ prefix=empty", () => {
    expect(getParentAndPrefix("/Users/dmtr/")).toEqual({
      parent: "/Users/dmtr/",
      prefix: "",
    });
  });

  test("splits / into parent=/ prefix=empty", () => {
    expect(getParentAndPrefix("/")).toEqual({
      parent: "/",
      prefix: "",
    });
  });

  test("empty string returns parent=/ prefix=empty", () => {
    expect(getParentAndPrefix("")).toEqual({
      parent: "/",
      prefix: "",
    });
  });
});

describe("expandTilde", () => {
  test("expands ~ at start to HOME", () => {
    const home = process.env.HOME ?? "/tmp";
    expect(expandTilde("~/code")).toBe(`${home}/code`);
  });

  test("does not expand ~ in middle", () => {
    expect(expandTilde("/foo/~bar")).toBe("/foo/~bar");
  });

  test("returns path unchanged if no tilde", () => {
    expect(expandTilde("/usr/local")).toBe("/usr/local");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/tui/path-input.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement PathInput**

Create `src/tui/components/PathInput.tsx`:

```tsx
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { runTuiSilentPromise } from "../runtime";
import { useBlink } from "../hooks/useBlink";
import { type ListItem, getVisibleWindow } from "./ScrollableList";
import { Effect, FileSystem } from "effect";

/** Expand leading ~ to $HOME */
export function expandTilde(path: string): string {
  if (path.startsWith("~")) {
    const home = process.env.HOME ?? "/tmp";
    return home + path.slice(1);
  }
  return path;
}

/** Split input into parent directory and prefix for filtering */
export function getParentAndPrefix(input: string): {
  parent: string;
  prefix: string;
} {
  if (!input || input === "/") return { parent: "/", prefix: "" };
  if (input.endsWith("/")) return { parent: input, prefix: "" };
  const lastSlash = input.lastIndexOf("/");
  if (lastSlash === -1) return { parent: "/", prefix: input };
  return {
    parent: input.slice(0, lastSlash + 1),
    prefix: input.slice(lastSlash + 1),
  };
}

interface PathInputProps {
  value: string;
  onChange: (value: string) => void;
  isFocused: boolean;
  isGitRepo: boolean;
}

export function PathInput({
  value,
  onChange,
  isFocused,
  isGitRepo,
}: PathInputProps) {
  const cursorVisible = useBlink();
  const [completions, setCompletions] = useState<ListItem[]>([]);
  const [selectedCompletionIndex, setSelectedCompletionIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced directory listing
  const loadCompletions = useCallback(
    (inputValue: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        const expanded = expandTilde(inputValue);
        const { parent } = getParentAndPrefix(expanded);
        try {
          const entries = await runTuiSilentPromise(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const items = yield* fs.readDirectory(parent);
              const dirs: string[] = [];
              for (const item of items) {
                const fullPath = parent + item;
                const stat = yield* fs.stat(fullPath);
                if (stat.type === "Directory") {
                  dirs.push(item);
                }
              }
              return dirs.sort();
            }),
          );
          setCompletions(
            entries.map((d) => ({ label: d, value: d })),
          );
          setSelectedCompletionIndex(0);
        } catch {
          setCompletions([]);
          setSelectedCompletionIndex(0);
        }
      }, 100);
    },
    [],
  );

  useEffect(() => {
    if (isFocused) loadCompletions(value);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, isFocused, loadCompletions]);

  // Filter completions by prefix
  const expanded = expandTilde(value);
  const { prefix } = getParentAndPrefix(expanded);
  const filtered = prefix
    ? completions.filter((c) =>
        c.label.toLowerCase().startsWith(prefix.toLowerCase()),
      )
    : completions;

  useInput(
    (input, key) => {
      if (key.downArrow) {
        setSelectedCompletionIndex((prev) =>
          Math.min(prev + 1, filtered.length - 1),
        );
        return;
      }
      if (key.upArrow) {
        setSelectedCompletionIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (key.rightArrow && filtered.length > 0) {
        // Accept completion
        const selected = filtered[selectedCompletionIndex];
        if (selected) {
          const { parent } = getParentAndPrefix(expanded);
          // Reconstruct with tilde if original used it
          const newExpanded = parent + selected.value + "/";
          const newValue = value.startsWith("~")
            ? "~" + newExpanded.slice((process.env.HOME ?? "/tmp").length)
            : newExpanded;
          onChange(newValue);
          setSelectedCompletionIndex(0);
        }
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      // Regular character input
      if (
        input &&
        !key.ctrl &&
        !key.meta &&
        !key.escape &&
        !key.return &&
        !key.tab
      ) {
        onChange(value + input);
      }
    },
    { isActive: isFocused },
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>
          Path:{" "}
        </Text>
        <Text>
          {value}
          {isFocused && cursorVisible ? "▎" : " "}
        </Text>
        {isGitRepo && <Text color="green"> ✓</Text>}
      </Box>
      {isFocused && filtered.length > 0 && (
        <Box flexDirection="column" marginLeft={6}>
          {(() => {
            const maxVisible = 8;
            const { start, end, hasAbove, hasBelow } = getVisibleWindow(
              filtered.length,
              selectedCompletionIndex,
              maxVisible,
            );
            const visible = filtered.slice(start, end);
            return (
              <>
                {hasAbove && <Text dimColor> ▲</Text>}
                {visible.map((item, i) => {
                  const actualIndex = start + i;
                  const isSelected = actualIndex === selectedCompletionIndex;
                  return (
                    <Text
                      key={item.value}
                      color={isSelected ? "cyan" : "dim"}
                      bold={isSelected}
                    >
                      {isSelected ? "▸ " : "  "}
                      {item.label}/
                    </Text>
                  );
                })}
                {hasBelow && <Text dimColor> ▼</Text>}
              </>
            );
          })()}
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `bun run test tests/tui/path-input.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/PathInput.tsx tests/tui/path-input.test.tsx
git commit -m "feat(tui): add PathInput component with filesystem completion"
```

---

### Task 4: Create `AddProjectModal` component

**Files:**
- Create: `src/tui/components/AddProjectModal.tsx`

- [ ] **Step 1: Implement AddProjectModal**

Create `src/tui/components/AddProjectModal.tsx`:

```tsx
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { runTuiSilentPromise } from "../runtime";
import { useBlink } from "../hooks/useBlink";
import { Modal } from "./Modal";
import { SubmitButton } from "./form-controls";
import { PathInput, expandTilde } from "./PathInput";
import { pathExists } from "../../services/filesystem";
import * as path from "node:path";

export interface AddProjectModalResult {
  path: string;
  name: string;
}

export interface AddProjectModalProps {
  visible: boolean;
  width?: number;
  onSubmit: (result: AddProjectModalResult) => void;
  onCancel: () => void;
}

type AddProjectField = "path" | "name" | "submit";
const FIELDS: AddProjectField[] = ["path", "name", "submit"];

export function AddProjectModal({
  visible,
  width,
  onSubmit,
  onCancel,
}: AddProjectModalProps) {
  const cursorVisible = useBlink();
  const [focusIndex, setFocusIndex] = useState(0);
  const [pathValue, setPathValue] = useState("~/");
  const [nameValue, setNameValue] = useState("");
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [nameAutoFilled, setNameAutoFilled] = useState(false);

  const currentField = FIELDS[focusIndex] ?? "path";

  // Reset state when modal visibility changes
  useEffect(() => {
    if (visible) {
      setFocusIndex(0);
      setPathValue("~/");
      setNameValue("");
      setIsGitRepo(false);
      setNameAutoFilled(false);
    }
  }, [visible]);

  // Check if path is a git repo (debounced via PathInput's own debounce)
  useEffect(() => {
    const expanded = expandTilde(pathValue);
    if (!expanded || expanded.length < 2) {
      setIsGitRepo(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const gitPath = expanded.endsWith("/")
              ? expanded + ".git"
              : expanded + "/.git";
        const exists = await runTuiSilentPromise(pathExists(gitPath));
        if (!cancelled) setIsGitRepo(exists);
      } catch {
        if (!cancelled) setIsGitRepo(false);
      }
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pathValue]);

  // Auto-fill name when leaving path field
  const autoFillName = useCallback(() => {
    if (nameValue === "" || nameAutoFilled) {
      const expanded = expandTilde(pathValue);
      const basename = path.basename(expanded.replace(/\/+$/, ""));
      if (basename) {
        setNameValue(basename);
        setNameAutoFilled(true);
      }
    }
  }, [pathValue, nameValue, nameAutoFilled]);

  const handleSubmit = useCallback(() => {
    if (!isGitRepo) return;
    const expanded = expandTilde(pathValue).replace(/\/+$/, "");
    const name = nameValue || path.basename(expanded);
    onSubmit({ path: expanded, name });
  }, [isGitRepo, pathValue, nameValue, onSubmit]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.tab) {
        // When leaving path field, auto-fill name
        if (currentField === "path") autoFillName();
        setFocusIndex(
          (prev) => (prev + (key.shift ? -1 : 1) + FIELDS.length) % FIELDS.length,
        );
        return;
      }
      if (key.return && currentField === "path") {
        autoFillName();
        setFocusIndex(1); // advance to name
        return;
      }
    },
    { isActive: visible },
  );

  // Name field input handling
  useInput(
    (input, key) => {
      if (key.backspace || key.delete) {
        setNameValue((prev) => prev.slice(0, -1));
        setNameAutoFilled(false);
        return;
      }
      if (
        input &&
        !key.ctrl &&
        !key.meta &&
        !key.escape &&
        !key.return &&
        !key.tab
      ) {
        setNameValue((prev) => prev + input);
        setNameAutoFilled(false);
      }
    },
    { isActive: visible && currentField === "name" },
  );

  return (
    <Modal title="Add Project" visible={visible} width={width}>
      <Box flexDirection="column">
        <Text dimColor>Register a git repository</Text>
        <Box height={1} />
        <PathInput
          value={pathValue}
          onChange={(v) => {
            setPathValue(v);
            setNameAutoFilled(false);
          }}
          isFocused={currentField === "path"}
          isGitRepo={isGitRepo}
        />
        <Box height={1} />
        <Box>
          <Text
            color={currentField === "name" ? "cyan" : "dim"}
            bold={currentField === "name"}
          >
            Name:{" "}
          </Text>
          <Text>
            {nameValue}
            {currentField === "name" && cursorVisible ? "▎" : " "}
          </Text>
        </Box>
        <SubmitButton
          isFocused={currentField === "submit"}
          disabled={!isGitRepo}
          onSubmit={handleSubmit}
        />
        <Box height={1} />
        <Text dimColor>
          {"tab:next  shift+tab:prev  →:complete  enter:confirm  esc:cancel"}
        </Text>
      </Box>
    </Modal>
  );
}
```

- [ ] **Step 2: Run full test suite**

Run: `bun run test`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/AddProjectModal.tsx
git commit -m "feat(tui): add AddProjectModal component"
```

---

### Task 5: Wire modal actions and App.tsx rendering

**Files:**
- Modify: `src/tui/hooks/useModalActions.ts`
- Modify: `src/tui/App.tsx`
- Test: `tests/tui/modal-actions.test.ts`

- [ ] **Step 1: Write failing test for `createPrepareAddProjectModal`**

Add to `tests/tui/modal-actions.test.ts`:

```typescript
import { createPrepareAddProjectModal, createHandleAddProject } from "../../src/tui/hooks/useModalActions";

describe("createPrepareAddProjectModal", () => {
  test("sets mode to AddProjectModal", () => {
    const deps = makeDeps();
    const prepare = createPrepareAddProjectModal(deps);
    prepare();
    expect(deps.setMode).toHaveBeenCalledWith(Mode.AddProjectModal);
  });
});

describe("createHandleAddProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls register and refreshes on success", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");
    (runTuiSilentPromise as Mock).mockResolvedValueOnce({ id: "1", repoPath: "/repo", project: "myproj" });

    const deps = makeDeps({
      refreshAll: vi.fn().mockResolvedValue(undefined),
    });
    const handle = createHandleAddProject(deps);

    handle({ path: "/home/user/myproj", name: "myproj" });

    expect(deps.setMode).toHaveBeenCalledWith(Mode.Navigate);

    await vi.waitFor(() => {
      expect(runTuiSilentPromise).toHaveBeenCalled();
      expect(deps.refreshAll).toHaveBeenCalled();
    });
  });

  test("shows error on failure", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");
    (runTuiSilentPromise as Mock).mockRejectedValueOnce(new Error("already registered"));

    const deps = makeDeps();
    const handle = createHandleAddProject(deps);

    handle({ path: "/repo", name: "proj" });

    expect(deps.setMode).toHaveBeenCalledWith(Mode.Navigate);

    await vi.waitFor(() => {
      expect(deps.showActionError).toHaveBeenCalledWith("already registered");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/tui/modal-actions.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement `createPrepareAddProjectModal` and `createHandleAddProject`**

Add to `src/tui/hooks/useModalActions.ts`:

Import at top:
```typescript
import type { AddProjectModalResult } from "../components/AddProjectModal";
import { RegistryService } from "../../services/registry-service";
```

Add functions before `useModalActions`:

```typescript
export function createPrepareAddProjectModal(deps: ModalActionDeps) {
  return () => {
    deps.setMode(Mode.AddProjectModal);
  };
}

export function createHandleAddProject(deps: ModalActionDeps) {
  return (result: AddProjectModalResult) => {
    deps.setMode(Mode.Navigate);
    (async () => {
      try {
        await runTuiSilentPromise(
          RegistryService.use((s) => s.register(result.path, result.name)),
        );
        await deps.refreshAll();
      } catch (error) {
        deps.showActionError(toWctError(error).message);
      }
    })();
  };
}
```

Update `useModalActions` return:

```typescript
export function useModalActions(deps: ModalActionDeps) {
  return {
    prepareOpenModal: createPrepareOpenModal(deps),
    handleOpen: createHandleOpen(deps),
    prepareUpModal: createPrepareUpModal(deps),
    handleUpSubmit: createHandleUpSubmit(deps),
    prepareAddProjectModal: createPrepareAddProjectModal(deps),
    handleAddProject: createHandleAddProject(deps),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test tests/tui/modal-actions.test.ts`
Expected: PASS

- [ ] **Step 5: Wire AddProjectModal into App.tsx rendering**

In `src/tui/App.tsx`:

Import at top:
```typescript
import { AddProjectModal } from "./components/AddProjectModal";
```

In the render section (around line 469), add the `AddProjectModal` case in the conditional chain:

```tsx
{mode.type === "OpenModal" ? (
  <OpenModal ... />
) : mode.type === "UpModal" ? (
  <UpModal ... />
) : mode.type === "AddProjectModal" ? (
  <AddProjectModal
    visible
    width={Math.min(termCols, 60)}
    onSubmit={modalActions.handleAddProject}
    onCancel={() => setMode(Mode.Navigate)}
  />
) : (
  <Box flexDirection="column">
    {/* ... existing status bar ... */}
  </Box>
)}
```

Wire `prepareAddProjectModal` into `navCtx` (this automatically flows to `expCtx` since `expCtx` spreads `navCtx`):

```typescript
prepareAddProjectModal: modalActions.prepareAddProjectModal,
```

- [ ] **Step 6: Run full test suite**

Run: `bun run test`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/tui/hooks/useModalActions.ts src/tui/App.tsx tests/tui/modal-actions.test.ts
git commit -m "feat(tui): wire AddProjectModal into App and modal actions"
```

---

### Task 6: Add `a` keybinding to expanded input handler

**Files:**
- Modify: `src/tui/input/expanded.ts`
- Test: `tests/tui/input-expanded.test.ts`

- [ ] **Step 1: Write failing test for `a` keybinding in expanded mode**

The expanded handler (`handleExpandedInput`) handles each key explicitly and does NOT delegate unknown keys to the navigate handler. The `a` binding must be added explicitly. Add to `tests/tui/input-expanded.test.ts`:

```typescript
test("a calls prepareAddProjectModal in expanded mode", () => {
  const ctx = makeCtx();
  handleExpandedInput(ctx, "a", noKey);
  expect(ctx.prepareAddProjectModal).toHaveBeenCalled();
});
```

Update the test's `makeCtx` to include `prepareAddProjectModal: vi.fn()` if not already inherited from `NavigateContext`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/tui/input-expanded.test.ts`
Expected: FAIL — `a` key not handled

- [ ] **Step 3: Add `a` handler to `handleExpandedInput`**

In `src/tui/input/expanded.ts`, add after the existing `u` handler (around line 81):

```typescript
if (input === "a") {
  ctx.prepareAddProjectModal();
  return;
}
```

Note: `ExpandedContext extends NavigateContext`, and `navCtx` already has `prepareAddProjectModal` wired (from Task 2/5), so `expCtx = { ...navCtx, ... }` inherits it automatically. No changes needed to `ExpandedContext` interface or `expCtx` construction.

- [ ] **Step 4: Run tests**

Run: `bun run test`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/input/expanded.ts tests/tui/input-expanded.test.ts
git commit -m "feat(tui): support 'a' keybinding in expanded mode"
```

---

### Task 7: Manual testing and polish

- [ ] **Step 1: Run the TUI and test the full flow**

Run: `bun run src/index.ts tui`

Test:
1. Press `a` — AddProjectModal opens
2. Type a path — completions appear
3. Right arrow — accepts completion
4. Navigate to a valid git repo — green checkmark appears
5. Tab to Name — auto-fills with basename
6. Tab to Submit — press Enter
7. Project appears in tree
8. Escape — cancels modal cleanly
9. Submit with non-git-repo path — submit is disabled

- [ ] **Step 2: Run full test suite one final time**

Run: `bun run test`
Expected: All pass.

- [ ] **Step 3: Final commit if any polish needed**

```bash
git add -A
git commit -m "feat(tui): polish add project modal"
```

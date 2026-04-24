# TUI Modal Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify `wct` TUI modal session controls so `UpModal` and `OpenModal` use the same profile picker, `No IDE` toggle, and positive `Auto-switch` wording without changing command-layer behavior.

**Architecture:** Extract the shared session-option logic out of `UpModal` into a focused helper module plus a `SessionOptionsSection` component. Then migrate `UpModal` to wrap that shared section and migrate each `OpenModal` subform to compose it after task-specific fields while fixing the current unconditional `useInput(..., { isActive: true })` listener pattern.

**Tech Stack:** Bun, React/Ink, Effect v4, Vitest

---

## File Map

- Create: `src/tui/components/SessionOptionsSection.tsx`
- Create: `src/tui/components/session-options.ts`
- Create: `tests/tui/session-options.test.ts`
- Modify: `src/tui/components/UpModal.tsx`
- Modify: `src/tui/components/OpenModal.tsx`
- Modify: `tests/tui/up-modal.test.ts`
- Modify: `tests/tui/open-modal.test.tsx`

Responsibilities:

- `src/tui/components/session-options.ts`
  Expose pure helper types and functions for profile-option construction, raw selected value resolution, and submit gating.
- `src/tui/components/SessionOptionsSection.tsx`
  Render the shared profile picker, `No IDE`, `Auto-switch`, and submit controls with local filter/index state and parent-owned focus.
- `src/tui/components/UpModal.tsx`
  Become a thin shell around `SessionOptionsSection`.
- `src/tui/components/OpenModal.tsx`
  Keep the multi-step structure, replace per-form profile/toggle UI with `SessionOptionsSection`, and remove field listeners that stay active unconditionally.
- `tests/tui/session-options.test.ts`
  Cover the raw profile value contract: `""` for `(default)`, named profile string for configured profiles, and `undefined` only for no-match.
- `tests/tui/up-modal.test.ts`
  Verify `UpModal` still preserves its external submission semantics after helper extraction.
- `tests/tui/open-modal.test.tsx`
  Verify `OpenModal` now renders `Auto-switch`, preserves the no-profile behavior for `ExistingBranchForm`, and keeps the dual-list `FromPRForm` rendering inert when unfocused.

## Implementation Notes

- Use the approved implementation note from spec review: `onProfileChange(...)` should report the raw selected value, not the submit-ready profile.
- Represent the currently selected profile as:
  - `""` for `(default)`
  - non-empty string for a named configured profile
  - `undefined` only when filtering leaves no match
- Derive submit readiness from raw value presence:
  - when profiles exist, `canSubmit = selectedProfileValue !== undefined`
  - when profiles do not exist, profile validity does not block submit
- Only convert `""` to `undefined` at final submit boundaries.
- Do not run `bun run test` or lint manually in this repo. Let the repo hooks handle formatting, linting, and test execution when the coding session stops.

### Task 1: Extract shared session-option helpers

**Files:**
- Create: `src/tui/components/session-options.ts`
- Create: `tests/tui/session-options.test.ts`
- Modify: `tests/tui/up-modal.test.ts`

- [ ] **Step 1: Inspect the current `UpModal` helper and current tests**

Run:

```bash
nl -ba src/tui/components/UpModal.tsx | sed -n '1,180p'
```

Run:

```bash
nl -ba tests/tui/up-modal.test.ts | sed -n '1,220p'
```

Expected:
- `resolveUpModalSubmission(...)` currently lives in `UpModal.tsx`
- the existing tests cover default-profile omission and no-match submit blocking

- [ ] **Step 2: Write the new failing helper tests around raw selected values**

Create `tests/tui/session-options.test.ts` with this test module:

```ts
import { describe, expect, test } from "vitest";
import type { ListItem } from "../../src/tui/components/ScrollableList";
import {
  buildProfileItems,
  resolveSelectedProfileValue,
  resolveSessionOptionsSubmitState,
} from "../../src/tui/components/session-options";

const profileItems: ListItem[] = [
  { label: "(default)", value: "" },
  { label: "backend", value: "backend" },
];

describe("buildProfileItems", () => {
  test("prepends the default option", () => {
    expect(buildProfileItems(["backend"])).toEqual(profileItems);
  });
});

describe("resolveSelectedProfileValue", () => {
  test("returns undefined when profiles are configured but the filter has no matches", () => {
    expect(resolveSelectedProfileValue(["backend"], [], 0)).toBeUndefined();
  });

  test("returns an empty string for the default option", () => {
    expect(
      resolveSelectedProfileValue(["backend"], profileItems, 0),
    ).toBe("");
  });

  test("returns the selected configured profile name", () => {
    expect(
      resolveSelectedProfileValue(["backend"], profileItems, 1),
    ).toBe("backend");
  });
});

describe("resolveSessionOptionsSubmitState", () => {
  test("allows submit when no profiles are configured", () => {
    expect(
      resolveSessionOptionsSubmitState([], undefined),
    ).toEqual({ canSubmit: true, profile: undefined });
  });

  test("blocks submit when profiles exist but no option is selected", () => {
    expect(
      resolveSessionOptionsSubmitState(["backend"], undefined),
    ).toEqual({ canSubmit: false, profile: undefined });
  });

  test("maps the default raw value to an omitted profile at submit time", () => {
    expect(
      resolveSessionOptionsSubmitState(["backend"], ""),
    ).toEqual({ canSubmit: true, profile: undefined });
  });

  test("passes through a named profile at submit time", () => {
    expect(
      resolveSessionOptionsSubmitState(["backend"], "backend"),
    ).toEqual({ canSubmit: true, profile: "backend" });
  });
});
```

- [ ] **Step 3: Implement the helper module**

Create `src/tui/components/session-options.ts` with this shape:

```ts
import type { ListItem } from "./ScrollableList";

export interface SessionOptionsSubmitState {
  canSubmit: boolean;
  profile?: string;
}

export function buildProfileItems(profileNames: string[]): ListItem[] {
  return [
    { label: "(default)", value: "" },
    ...profileNames.map((profileName) => ({
      label: profileName,
      value: profileName,
    })),
  ];
}

export function resolveSelectedProfileValue(
  profileNames: string[],
  filteredProfiles: ListItem[],
  selectedProfileIndex: number,
): string | undefined {
  if (profileNames.length === 0) {
    return undefined;
  }

  return filteredProfiles[selectedProfileIndex]?.value;
}

export function resolveSessionOptionsSubmitState(
  profileNames: string[],
  selectedProfileValue: string | undefined,
): SessionOptionsSubmitState {
  if (profileNames.length === 0) {
    return { canSubmit: true, profile: undefined };
  }

  if (selectedProfileValue === undefined) {
    return { canSubmit: false, profile: undefined };
  }

  return {
    canSubmit: true,
    profile: selectedProfileValue || undefined,
  };
}
```

Constraints:
- keep the raw selected value contract explicit in the helper names
- use `""` only for the internal selected `(default)` option
- only collapse `""` to `undefined` in `resolveSessionOptionsSubmitState(...)`

- [ ] **Step 4: Move the existing `UpModal` helper test to the new helper module**

Replace `tests/tui/up-modal.test.ts` with this complete file:

```ts
import { describe, expect, test } from "vitest";
import type { ListItem } from "../../src/tui/components/ScrollableList";
import {
  resolveSelectedProfileValue,
  resolveSessionOptionsSubmitState,
} from "../../src/tui/components/session-options";

const profileItems: ListItem[] = [
  { label: "(default)", value: "" },
  { label: "backend", value: "backend" },
];

describe("UpModal submission semantics", () => {
  test("allows submit without a profile when none are configured", () => {
    const selectedProfileValue = resolveSelectedProfileValue([], [], 0);

    expect(
      resolveSessionOptionsSubmitState([], selectedProfileValue),
    ).toEqual({
      canSubmit: true,
      profile: undefined,
    });
  });

  test("blocks submit when the profile filter has no matches", () => {
    const selectedProfileValue = resolveSelectedProfileValue(
      ["backend"],
      [],
      0,
    );

    expect(
      resolveSessionOptionsSubmitState(["backend"], selectedProfileValue),
    ).toEqual({
      canSubmit: false,
      profile: undefined,
    });
  });

  test("maps the default profile option to an omitted --profile flag", () => {
    const selectedProfileValue = resolveSelectedProfileValue(
      ["backend"],
      profileItems,
      0,
    );

    expect(
      resolveSessionOptionsSubmitState(["backend"], selectedProfileValue),
    ).toEqual({
      canSubmit: true,
      profile: undefined,
    });
  });

  test("returns the selected named profile when one is highlighted", () => {
    const selectedProfileValue = resolveSelectedProfileValue(
      ["backend"],
      profileItems,
      1,
    );

    expect(
      resolveSessionOptionsSubmitState(["backend"], selectedProfileValue),
    ).toEqual({
      canSubmit: true,
      profile: "backend",
    });
  });
});
```

- [ ] **Step 5: Review the helper-only diff and commit**

Run:

```bash
git diff -- src/tui/components/session-options.ts tests/tui/session-options.test.ts tests/tui/up-modal.test.ts
```

Expected:
- one new helper module
- one new helper test file
- `tests/tui/up-modal.test.ts` no longer imports `resolveUpModalSubmission` from `UpModal.tsx`

Commit:

```bash
git add src/tui/components/session-options.ts tests/tui/session-options.test.ts tests/tui/up-modal.test.ts
git commit -m "refactor(tui): extract shared session option helpers"
```

### Task 2: Build `SessionOptionsSection` and migrate `UpModal`

**Files:**
- Create: `src/tui/components/SessionOptionsSection.tsx`
- Modify: `src/tui/components/UpModal.tsx`
- Modify: `tests/tui/up-modal.test.ts`

- [ ] **Step 1: Inspect the current `UpModal` render path and state reset**

Run:

```bash
nl -ba src/tui/components/UpModal.tsx | sed -n '1,260p'
```

Expected:
- `UpModal` currently owns `profileQuery`, `selectedProfileIndex`, `noIde`, `autoSwitch`, and submit resolution
- the modal already resets those values on `visible` change

- [ ] **Step 2: Write the failing `UpModal`-level render semantics test**

Extend `tests/tui/up-modal.test.ts` with:

```ts
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { afterEach, describe, expect, test, vi } from "vitest";
import { UpModal } from "../../src/tui/components/UpModal";

function createStreams() {
  const stdout = new PassThrough() as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 100;
  stdout.rows = 32;
  const stdin = new PassThrough() as NodeJS.ReadStream & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => NodeJS.ReadStream;
  };
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

test("renders the shared Auto-switch wording", async () => {
  const { stdout, stdin } = createStreams();
  const instance = render(
    <UpModal
      visible
      profileNames={["backend"]}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
    { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  const output = stdout.read()?.toString("utf8") ?? "";

  try {
    expect(output).toContain("Auto-switch");
    expect(output).not.toContain("No attach");
  } finally {
    instance.unmount();
  }
});
```

- [ ] **Step 3: Implement `SessionOptionsSection`**

Create `src/tui/components/SessionOptionsSection.tsx` with this structure:

```ts
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { ScrollableList, filterItems } from "./ScrollableList";
import { SubmitButton, ToggleRow } from "./form-controls";
import { TitledBox } from "./TitledBox";
import {
  buildProfileItems,
  resolveSelectedProfileValue,
} from "./session-options";

export interface SessionOptionsSectionProps {
  profileNames: string[];
  focusedField: "profile" | "noIde" | "autoSwitch" | "submit" | null;
  noIde: boolean;
  autoSwitch: boolean;
  canSubmit: boolean;
  onNoIdeToggle: () => void;
  onAutoSwitchToggle: () => void;
  onSubmit: () => void;
  onProfileChange: (profile: string | undefined) => void;
  resetKey: string;
  width?: number;
}

export function SessionOptionsSection({
  profileNames,
  focusedField,
  noIde,
  autoSwitch,
  canSubmit,
  onNoIdeToggle,
  onAutoSwitchToggle,
  onSubmit,
  onProfileChange,
  resetKey,
  width,
}: SessionOptionsSectionProps) {
  const [profileQuery, setProfileQuery] = useState("");
  const [selectedProfileIndex, setSelectedProfileIndex] = useState(0);

  const profileItems = useMemo(
    () => buildProfileItems(profileNames),
    [profileNames],
  );
  const filteredProfiles = useMemo(
    () => filterItems(profileItems, profileQuery),
    [profileItems, profileQuery],
  );

  useEffect(() => {
    setProfileQuery("");
    setSelectedProfileIndex(0);
  }, [resetKey]);

  useEffect(() => {
    setSelectedProfileIndex((prev) =>
      filteredProfiles.length === 0
        ? 0
        : Math.min(prev, filteredProfiles.length - 1),
    );
  }, [filteredProfiles.length]);

  useEffect(() => {
    onProfileChange(
      resolveSelectedProfileValue(
        profileNames,
        filteredProfiles,
        selectedProfileIndex,
      ),
    );
  }, [profileNames, filteredProfiles, selectedProfileIndex, onProfileChange]);

  useInput(
    (input, key) => {
      if (focusedField !== "profile") return;
      if (key.upArrow) {
        setSelectedProfileIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedProfileIndex((prev) =>
          Math.min(filteredProfiles.length - 1, prev + 1),
        );
        return;
      }
      if (key.backspace || key.delete) {
        setProfileQuery((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.return) {
        setProfileQuery((prev) => prev + input);
      }
    },
    { isActive: focusedField === "profile" },
  );

  return (
    <Box flexDirection="column">
      {profileNames.length > 0 ? (
        <TitledBox
          title={profileQuery ? `Profile filter: ${profileQuery}` : "Profile"}
          isFocused={focusedField === "profile"}
          width={width}
        >
          <ScrollableList
            items={profileItems}
            selectedIndex={selectedProfileIndex}
            filterQuery={profileQuery}
            isFocused={focusedField === "profile"}
            maxVisible={6}
          />
        </TitledBox>
      ) : null}
      <Box height={1} />
      <ToggleRow
        label="No IDE"
        checked={noIde}
        isFocused={focusedField === "noIde"}
        onToggle={onNoIdeToggle}
      />
      <ToggleRow
        label="Auto-switch"
        checked={autoSwitch}
        isFocused={focusedField === "autoSwitch"}
        onToggle={onAutoSwitchToggle}
      />
      <SubmitButton
        isFocused={focusedField === "submit"}
        disabled={!canSubmit}
        onSubmit={onSubmit}
      />
    </Box>
  );
}
```

- [ ] **Step 4: Rewrite `UpModal` as a shell around the shared section**

Update `src/tui/components/UpModal.tsx` to this shape:

```ts
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import { SessionOptionsSection } from "./SessionOptionsSection";
import { resolveSessionOptionsSubmitState } from "./session-options";

export interface UpModalResult {
  profile?: string;
  noIde: boolean;
  autoSwitch: boolean;
}

export interface UpModalProps {
  visible: boolean;
  width?: number;
  profileNames: string[];
  onSubmit: (result: UpModalResult) => void;
  onCancel: () => void;
}

type UpModalField = "profile" | "noIde" | "autoSwitch" | "submit";

export function UpModal({
  visible,
  width,
  profileNames,
  onSubmit,
  onCancel,
}: UpModalProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const [selectedProfileValue, setSelectedProfileValue] = useState<
    string | undefined
  >(undefined);
  const [noIde, setNoIde] = useState(false);
  const [autoSwitch, setAutoSwitch] = useState(true);

  const fields = useMemo<UpModalField[]>(() => {
    const nextFields: UpModalField[] = [];
    if (profileNames.length > 0) nextFields.push("profile");
    nextFields.push("noIde", "autoSwitch", "submit");
    return nextFields;
  }, [profileNames.length]);

  const currentField = fields[focusIndex] ?? null;
  const submission = useMemo(
    () => resolveSessionOptionsSubmitState(profileNames, selectedProfileValue),
    [profileNames, selectedProfileValue],
  );

  useEffect(() => {
    if (!visible) return;
    setFocusIndex(0);
    setSelectedProfileValue(undefined);
    setNoIde(false);
    setAutoSwitch(true);
  }, [visible]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.tab) {
        setFocusIndex((prev) => (prev + (key.shift ? -1 : 1) + fields.length) % fields.length);
      }
    },
    { isActive: visible },
  );

  return (
    <Modal title="wct up" visible={visible} width={width}>
      <Box flexDirection="column">
        <Text dimColor>Start worktree session</Text>
        <Box height={1} />
        <SessionOptionsSection
          profileNames={profileNames}
          focusedField={currentField}
          noIde={noIde}
          autoSwitch={autoSwitch}
          canSubmit={submission.canSubmit}
          onNoIdeToggle={() => setNoIde((prev) => !prev)}
          onAutoSwitchToggle={() => setAutoSwitch((prev) => !prev)}
          onSubmit={() => {
            if (!submission.canSubmit) return;
            onSubmit({
              profile: submission.profile,
              noIde,
              autoSwitch,
            });
          }}
          onProfileChange={setSelectedProfileValue}
          resetKey={visible ? "visible" : "hidden"}
          width={width ? width - 2 : undefined}
        />
        <Box height={1} />
        <Text dimColor>{"tab:next  shift+tab:prev  esc:cancel"}</Text>
      </Box>
    </Modal>
  );
}
```

Constraints:
- `UpModal` keeps its public props and result type unchanged
- submit still emits `profile?: string`, `noIde`, and `autoSwitch`
- `resetKey` may stay simple in `UpModal` because there is no step switching

- [ ] **Step 5: Review the shared-section diff and commit**

Run:

```bash
git diff -- src/tui/components/SessionOptionsSection.tsx src/tui/components/UpModal.tsx tests/tui/up-modal.test.ts
```

Expected:
- `UpModal` is now mostly shell and focus wiring
- profile filtering logic no longer lives in `UpModal.tsx`
- the rendered wording is `Auto-switch`

Commit:

```bash
git add src/tui/components/SessionOptionsSection.tsx src/tui/components/UpModal.tsx tests/tui/up-modal.test.ts
git commit -m "refactor(tui): share session options in up modal"
```

### Task 3: Migrate `OpenModal` forms to the shared section

**Files:**
- Modify: `src/tui/components/OpenModal.tsx`
- Modify: `tests/tui/open-modal.test.tsx`

- [ ] **Step 1: Inspect the current open subform boundaries**

Run:

```bash
nl -ba src/tui/components/OpenModal.tsx | sed -n '1,760p'
```

Expected:
- `NewBranchForm`, `FromPRForm`, and `ExistingBranchForm` each own their own option toggles
- all three forms currently use `No attach`
- `NewBranchForm` and `FromPRForm` currently accept free-text profile input

- [ ] **Step 2: Write the failing `OpenModal` render tests for the unified wording**

Update `tests/tui/open-modal.test.tsx` from:

```ts
test("new branch form shows No IDE and No attach toggles", async () => {
```

to:

```ts
test("new branch form shows No IDE and Auto-switch toggles", async () => {
```

Update the three assertions from:

```ts
expect(rendered.output).toContain("No attach");
```

to:

```ts
expect(rendered.output).toContain("Auto-switch");
expect(rendered.output).not.toContain("No attach");
```

Also add one explicit profile-presence assertion for the existing-branch case:

```ts
expect(rendered.output).not.toContain("Profile");
```

And add one explicit dual-list render assertion for the PR case:

```ts
expect(rendered.output).toContain("Select PR");
expect(rendered.output).toContain("Profile");
```

- [ ] **Step 3: Replace `OpenModal` option rows with `SessionOptionsSection`**

Update the field unions first so the typed field arrays accept `autoSwitch`:

```ts
type NewBranchField =
  | "branch"
  | "base"
  | "profile"
  | "prompt"
  | "noIde"
  | "autoSwitch"
  | "submit";
```

```ts
type FromPRField =
  | "prList"
  | "profile"
  | "prompt"
  | "noIde"
  | "autoSwitch"
  | "submit";
```

For `NewBranchForm`, replace:

```ts
const [profile, setProfile] = useState("");
const [noAttach, setNoAttach] = useState(false);
```

with:

```ts
const [selectedProfileValue, setSelectedProfileValue] = useState<
  string | undefined
>(undefined);
const [autoSwitch, setAutoSwitch] = useState(true);
```

Compute submit state with:

```ts
const submission = useMemo(
  () => resolveSessionOptionsSubmitState(profileNames, selectedProfileValue),
  [profileNames, selectedProfileValue],
);
```

Render the shared section instead of the old profile input and toggle rows:

```tsx
<SessionOptionsSection
  profileNames={profileNames}
  focusedField={
    currentField === "profile" ||
    currentField === "noIde" ||
    currentField === "autoSwitch" ||
    currentField === "submit"
      ? currentField
      : null
  }
  noIde={noIde}
  autoSwitch={autoSwitch}
  canSubmit={submission.canSubmit && branch.trim().length > 0}
  onNoIdeToggle={() => setNoIde((prev) => !prev)}
  onAutoSwitchToggle={() => setAutoSwitch((prev) => !prev)}
  onSubmit={() => {
    if (!branch.trim() || !submission.canSubmit) return;
    onSubmit({
      branch: branch.trim(),
      base: base.trim() || undefined,
      profile: submission.profile,
      prompt: prompt.trim() || undefined,
      existing: false,
      noIde,
      noAttach: !autoSwitch,
    });
  }}
  onProfileChange={setSelectedProfileValue}
  resetKey="new-branch"
  width={width}
/>
```

For `FromPRForm`, make the state and submit path explicit:

```ts
const [selectedProfileValue, setSelectedProfileValue] = useState<
  string | undefined
>(undefined);
const [noIde, setNoIde] = useState(false);
const [autoSwitch, setAutoSwitch] = useState(true);

const fields = useMemo(() => {
  const f: FromPRField[] = ["prList"];
  if (profileNames.length > 0) f.push("profile");
  f.push("prompt", "noIde", "autoSwitch", "submit");
  return f;
}, [profileNames.length]);

const submission = useMemo(
  () => resolveSessionOptionsSubmitState(profileNames, selectedProfileValue),
  [profileNames, selectedProfileValue],
);
```

Replace the old free-text profile input plus toggles with:

```tsx
<PromptArea
  value={prompt}
  isFocused={currentField === "prompt"}
  onChange={setPrompt}
  width={width}
/>
<SessionOptionsSection
  profileNames={profileNames}
  focusedField={
    currentField === "profile" ||
    currentField === "noIde" ||
    currentField === "autoSwitch" ||
    currentField === "submit"
      ? currentField
      : null
  }
  noIde={noIde}
  autoSwitch={autoSwitch}
  canSubmit={
    submission.canSubmit && Boolean(filteredPRItems[selectedPRIndex])
  }
  onNoIdeToggle={() => setNoIde((prev) => !prev)}
  onAutoSwitchToggle={() => setAutoSwitch((prev) => !prev)}
  onSubmit={() => {
    const selectedPR = filteredPRItems[selectedPRIndex];
    if (!selectedPR || !submission.canSubmit) return;
    const pr = prList.find((p) => String(p.number) === selectedPR.value);
    if (!pr) return;
    onSubmit({
      branch: pr.headRefName,
      pr: String(pr.number),
      profile: submission.profile,
      prompt: prompt.trim() || undefined,
      existing: false,
      noIde,
      noAttach: !autoSwitch,
    });
  }}
  onProfileChange={setSelectedProfileValue}
  resetKey="from-pr"
  width={width}
/>
```

For `ExistingBranchForm`, keep the function signature unchanged and hardcode the empty profile list at the shared-section boundary:

```ts
type ExistingBranchField =
  | "branchList"
  | "prompt"
  | "noIde"
  | "autoSwitch"
  | "submit";

const [noIde, setNoIde] = useState(false);
const [autoSwitch, setAutoSwitch] = useState(true);

const submission = useMemo(
  () => resolveSessionOptionsSubmitState([], undefined),
  [],
);
```

Replace the old toggles with:

```tsx
<PromptArea
  value={prompt}
  isFocused={currentField === "prompt"}
  onChange={setPrompt}
  width={width}
/>
<SessionOptionsSection
  profileNames={[]}
  focusedField={
    currentField === "noIde" ||
    currentField === "autoSwitch" ||
    currentField === "submit"
      ? currentField
      : null
  }
  noIde={noIde}
  autoSwitch={autoSwitch}
  canSubmit={submission.canSubmit && Boolean(filteredBranchItems[selectedBranchIndex])}
  onNoIdeToggle={() => setNoIde((prev) => !prev)}
  onAutoSwitchToggle={() => setAutoSwitch((prev) => !prev)}
  onSubmit={() => {
    const selectedBranch = filteredBranchItems[selectedBranchIndex];
    if (!selectedBranch) return;
    onSubmit({
      branch: selectedBranch.value,
      prompt: prompt.trim() || undefined,
      existing: true,
      noIde,
      noAttach: !autoSwitch,
    });
  }}
  onProfileChange={() => {}}
  resetKey="existing-branch"
  width={width}
/>
```

- [ ] **Step 4: Fix the listener-activation bug while migrating the forms**

Update each `useInput` call in `OpenModal.tsx` so form-specific handlers only run while that form is visible and only consume keys they actually own.

Required changes for each call site:

- `ModeSelector` stays active while rendered, but keep its handler limited to selector-owned keys:

```ts
useInput(
  (_input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(options.length - 1, s + 1));
    if (key.return) onSelect(options[selected]?.step ?? "newBranch");
    if (key.escape) onCancel();
  },
  { isActive: true },
);
```

Because `ModeSelector` only renders in the selector step, `isActive: true` is acceptable here.

- `BracketInput` keeps:

```ts
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
```

- `PromptArea` keeps:

```ts
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
```

- `NewBranchForm` becomes:

```ts
useInput(
  (_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.tab) {
      moveFocus(key.shift ? -1 : 1);
      return;
    }
  },
  { isActive: true },
);
```

This form no longer owns any arrow-key or typing logic beyond `BracketInput`, `PromptArea`, and the shared section.

- `FromPRForm` becomes:

```ts
useInput(
  (input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.tab) {
      moveFocus(key.shift ? -1 : 1);
      return;
    }
    if (currentField !== "prList") {
      return;
    }
    if (key.upArrow) {
      setSelectedPRIndex((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedPRIndex((s) =>
        Math.min(filteredPRItems.length - 1, s + 1),
      );
      return;
    }
    if (key.backspace || key.delete) {
      setFilterQuery((q) => q.slice(0, -1));
      setSelectedPRIndex(0);
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.return) {
      setFilterQuery((q) => q + input);
      setSelectedPRIndex(0);
    }
  },
  { isActive: true },
);
```

- `ExistingBranchForm` becomes:

```ts
useInput(
  (input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.tab) {
      moveFocus(key.shift ? -1 : 1);
      return;
    }
    if (currentField !== "branchList") {
      return;
    }
    if (key.upArrow) {
      setSelectedBranchIndex((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedBranchIndex((s) =>
        Math.min(filteredBranchItems.length - 1, s + 1),
      );
      return;
    }
    if (key.backspace || key.delete) {
      setFilterQuery((q) => q.slice(0, -1));
      setSelectedBranchIndex(0);
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.return) {
      setFilterQuery((q) => q + input);
      setSelectedBranchIndex(0);
    }
  },
  { isActive: true },
);
```

Implementation rule:
- parent forms keep tab and escape handling
- `SessionOptionsSection` owns only profile-list filtering and profile-list arrow navigation
- PR-list and branch-list handlers return immediately unless their own list field is focused
- remove the old `BracketInput` profile field entirely from `NewBranchForm` and `FromPRForm`

- [ ] **Step 5: Review the open-modal migration diff and commit**

Run:

```bash
git diff -- src/tui/components/OpenModal.tsx tests/tui/open-modal.test.tsx
```

Expected:
- `OpenModal` uses `SessionOptionsSection` in each subform
- `No attach` text is gone
- `ExistingBranchForm` still has no profile picker
- `FromPRForm` still renders both list boxes when profiles exist

Commit:

```bash
git add src/tui/components/OpenModal.tsx tests/tui/open-modal.test.tsx
git commit -m "refactor(tui): unify open modal session controls"
```

### Task 4: Finalize reset behavior and verify the full modal boundary

**Files:**
- Modify: `src/tui/components/OpenModal.tsx`
- Modify: `src/tui/components/UpModal.tsx`
- Modify: `tests/tui/open-modal.test.tsx`
- Modify: `tests/tui/up-modal.test.ts`

- [ ] **Step 1: Make parent option-state resets explicit in `OpenModal`**

Add one reset effect per form so parent-owned option state does not leak across steps.

For `NewBranchForm`, use:

```ts
useEffect(() => {
  setSelectedProfileValue(undefined);
  setNoIde(false);
  setAutoSwitch(true);
}, []);
```

For `FromPRForm`, use:

```ts
useEffect(() => {
  setSelectedProfileValue(undefined);
  setNoIde(false);
  setAutoSwitch(true);
}, []);
```

For `ExistingBranchForm`, reset:

```ts
useEffect(() => {
  setNoIde(false);
  setAutoSwitch(true);
}, []);
```

If the implementation chooses to keep each form mounted across internal state transitions, change these effects to depend on a step-scoped `resetKey` prop instead of `[]`.

- [ ] **Step 2: Add a focused reset contract test**

Add one `OpenModal` render assertion proving the existing-branch form still does not render profile UI after the migration:

```ts
expect(rendered.output).not.toContain("Profile filter:");
expect(rendered.output).not.toContain("(default)");
```

- [ ] **Step 3: Perform a final source audit before handing off to hooks**

Run:

```bash
rg -n "No attach|resolveUpModalSubmission|label=\\\"Profile\\\"|setProfile\\(" src/tui/components tests/tui
```

Expected:
- no remaining `No attach` label in the TUI modal components or modal tests
- no remaining `resolveUpModalSubmission`
- no remaining free-text profile input state in `OpenModal`

Run:

```bash
git diff -- src/tui/components/SessionOptionsSection.tsx src/tui/components/session-options.ts src/tui/components/UpModal.tsx src/tui/components/OpenModal.tsx tests/tui/session-options.test.ts tests/tui/up-modal.test.ts tests/tui/open-modal.test.tsx
```

Expected:
- the diff is limited to the planned modal-unification boundary

- [ ] **Step 4: Hand off to repo hooks for formatting, lint, and tests**

Action:
- stop the coding session so the repo hooks run `biome format --write`, `biome lint --write`, and `bun run test`

Expected:
- formatting changes are applied automatically
- lint passes
- the full test suite passes

- [ ] **Step 5: Commit the reset/finalization pass**

```bash
git add src/tui/components/SessionOptionsSection.tsx src/tui/components/session-options.ts src/tui/components/UpModal.tsx src/tui/components/OpenModal.tsx tests/tui/session-options.test.ts tests/tui/up-modal.test.ts tests/tui/open-modal.test.tsx
git commit -m "refactor(tui): finalize modal reset behavior"
```

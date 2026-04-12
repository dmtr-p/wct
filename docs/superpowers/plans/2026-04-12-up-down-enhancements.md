# Up/Down Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--path`/`--branch` flags to CLI `up`/`down` commands and add `u`/`d` keybindings in the TUI.

**Architecture:** Shared worktree path resolution helper used by both CLI commands. New `UpModal` TUI component built from existing `TitledBox`/`Modal` primitives. New `ConfirmDown` mode for session kill confirmation. The `ToggleRow` and `SubmitButton` sub-components from `OpenModal.tsx` are extracted to a shared file so `UpModal` can reuse them.

**Tech Stack:** Effect v4, React/Ink, Bun, vitest

---

### Task 1: Extract shared sub-components from OpenModal

**Files:**
- Create: `src/tui/components/form-controls.tsx`
- Modify: `src/tui/components/OpenModal.tsx`

- [ ] **Step 1: Create `form-controls.tsx` with `ToggleRow` and `SubmitButton`**

```tsx
// src/tui/components/form-controls.tsx
import { Box, Text, useInput } from "ink";

export function ToggleRow({
  label,
  checked,
  isFocused,
  onToggle,
}: {
  label: string;
  checked: boolean;
  isFocused: boolean;
  onToggle: () => void;
}) {
  useInput(
    (input) => {
      if (input === " ") onToggle();
    },
    { isActive: isFocused },
  );

  return (
    <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>
      {checked ? "[x]" : "[ ]"} {label}
    </Text>
  );
}

export function SubmitButton({
  isFocused,
  onSubmit,
}: {
  isFocused: boolean;
  onSubmit: () => void;
}) {
  useInput(
    (input, key) => {
      if (key.return || input === " ") onSubmit();
    },
    { isActive: isFocused },
  );

  return (
    <Box marginTop={1}>
      <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>
        {isFocused ? "▸ " : "  "}Submit
      </Text>
    </Box>
  );
}
```

- [ ] **Step 2: Update `OpenModal.tsx` to import from `form-controls.tsx`**

Remove the local `ToggleRow` and `SubmitButton` definitions from `OpenModal.tsx` and replace with:

```tsx
import { SubmitButton, ToggleRow } from "./form-controls";
```

Delete lines 155–201 (the local `ToggleRow` and `SubmitButton` functions) from `OpenModal.tsx`.

- [ ] **Step 3: Run tests to verify nothing broke**

Run: `bun run test`
Expected: All existing tests pass (no behavioral change).

- [ ] **Step 4: Commit**

```bash
git add src/tui/components/form-controls.tsx src/tui/components/OpenModal.tsx
git commit -m "refactor: extract ToggleRow and SubmitButton to shared form-controls"
```

---

### Task 2: Add `resolveWorktreePath` helper

**Files:**
- Create: `src/commands/resolve-worktree-path.ts`
- Create: `tests/resolve-worktree-path.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/resolve-worktree-path.test.ts
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolveWorktreePath } from "../src/commands/resolve-worktree-path";
import { runBunPromise } from "../src/effect/runtime";
import {
  liveWorktreeService,
  WorktreeService,
} from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

describe("resolveWorktreePath", () => {
  let repoDir: string;
  let wtPath: string;
  const originalDir = process.cwd();

  beforeAll(async () => {
    repoDir = await realpath(await mkdtemp(join(tmpdir(), "wct-resolve-")));
    await $`git init -b main`.quiet().cwd(repoDir);
    await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
    await $`git config user.name "Test"`.quiet().cwd(repoDir);
    await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
    await $`git commit --allow-empty -m "initial"`.quiet().cwd(repoDir);
    wtPath = join(repoDir, ".worktrees", "feature-a");
    await $`git worktree add -b feature-a ${wtPath}`.quiet().cwd(repoDir);
  });

  afterAll(async () => {
    process.chdir(originalDir);
    await $`git worktree remove ${wtPath}`.quiet().cwd(repoDir).nothrow();
    await rm(repoDir, { recursive: true, force: true });
  });

  test("returns cwd when no options given", async () => {
    process.chdir(repoDir);
    const result = await runBunPromise(
      withTestServices(resolveWorktreePath({}), {
        worktree: liveWorktreeService,
      }),
    );
    expect(result).toBe(repoDir);
  });

  test("returns path directly when --path is given", async () => {
    process.chdir(repoDir);
    const result = await runBunPromise(
      withTestServices(resolveWorktreePath({ path: wtPath }), {
        worktree: liveWorktreeService,
      }),
    );
    expect(result).toBe(wtPath);
  });

  test("resolves path from branch name when --branch is given", async () => {
    process.chdir(repoDir);
    const result = await runBunPromise(
      withTestServices(resolveWorktreePath({ branch: "feature-a" }), {
        worktree: liveWorktreeService,
      }),
    );
    expect(result).toBe(wtPath);
  });

  test("errors when both --path and --branch are given", async () => {
    process.chdir(repoDir);
    await expect(
      runBunPromise(
        withTestServices(
          resolveWorktreePath({ path: wtPath, branch: "feature-a" }),
          { worktree: liveWorktreeService },
        ),
      ),
    ).rejects.toThrow("--path and --branch are mutually exclusive");
  });

  test("errors when --branch does not match any worktree", async () => {
    process.chdir(repoDir);
    await expect(
      runBunPromise(
        withTestServices(resolveWorktreePath({ branch: "nonexistent" }), {
          worktree: liveWorktreeService,
        }),
      ),
    ).rejects.toThrow("No worktree found for branch 'nonexistent'");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/resolve-worktree-path.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `resolveWorktreePath`**

```ts
// src/commands/resolve-worktree-path.ts
import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { WorktreeService } from "../services/worktree-service";

export interface ResolveWorktreePathOptions {
  path?: string;
  branch?: string;
}

export function resolveWorktreePath(
  options: ResolveWorktreePathOptions,
): Effect.Effect<string, WctError, WctServices> {
  return Effect.gen(function* () {
    const { path, branch } = options;

    if (path && branch) {
      return yield* Effect.fail(
        commandError(
          "invalid_args",
          "--path and --branch are mutually exclusive",
        ),
      );
    }

    if (path) {
      return path;
    }

    if (branch) {
      const worktrees = yield* WorktreeService.use((service) =>
        service.listWorktrees(),
      );
      const match = worktrees.find((wt) => wt.branch === branch);
      if (!match) {
        return yield* Effect.fail(
          commandError(
            "worktree_error",
            `No worktree found for branch '${branch}'`,
          ),
        );
      }
      return match.path;
    }

    return process.cwd();
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test tests/resolve-worktree-path.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/resolve-worktree-path.ts tests/resolve-worktree-path.test.ts
git commit -m "feat: add resolveWorktreePath helper for --path/--branch flags"
```

---

### Task 3: Add `--path`/`--branch` flags to `up` command

**Files:**
- Modify: `src/commands/up.ts`
- Modify: `src/cli/root-command.ts`
- Modify: `tests/up.test.ts`

- [ ] **Step 1: Write failing test for `--branch` resolution in `upCommand`**

Add to `tests/up.test.ts`:

```ts
import { resolveWorktreePath } from "../src/commands/resolve-worktree-path";
```

Add a new test inside `describe("upCommand")`:

```ts
test("resolves worktree path via --branch flag", async () => {
  const fixture = await createLinkedWorktreeFixture(
    "wct-up-branch-flag-",
    "wct-up-branch-flag-wt-",
  );
  const originalDir = process.cwd();
  const wtPath = join(fixture.worktreeDir, "feature-branch");

  try {
    await Bun.write(
      join(fixture.repoDir, ".wct.yaml"),
      `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
`,
    );

    // Start from the main repo dir, but target the worktree via --branch
    process.chdir(fixture.repoDir);

    const createCalls: string[] = [];
    await runBunPromise(
      withTestServices(
        upCommand({ branch: "feature-branch" }),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(fixture.repoDir),
            getCurrentBranch: (cwd?: string) =>
              Effect.succeed(cwd === wtPath ? "feature-branch" : "main"),
          },
          tmux: {
            ...liveTmuxService,
            createSession: (opts) =>
              Effect.sync(() => {
                createCalls.push(opts.workingDir);
                return { _tag: "Created" as const, sessionName: "test" };
              }),
          },
        },
      ),
    );

    expect(createCalls[0]).toBe(wtPath);
  } finally {
    process.chdir(originalDir);
    await cleanupLinkedWorktreeFixture(fixture, originalDir);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/up.test.ts`
Expected: FAIL — `branch` not in `UpOptions`.

- [ ] **Step 3: Update `up.ts` to accept `--path`/`--branch` and use `resolveWorktreePath`**

In `src/commands/up.ts`, update `UpOptions`:

```ts
export interface UpOptions {
  noIde?: boolean;
  noAttach?: boolean;
  profile?: string;
  path?: string;
  branch?: string;
}
```

Update `commandDef.options` to add the two new flags:

```ts
options: [
  {
    name: "path",
    type: "string",
    placeholder: "path",
    description: "Path to worktree directory",
  },
  {
    name: "branch",
    short: "b",
    type: "string",
    placeholder: "name",
    description: "Branch name to resolve worktree from",
    completionValues: "__wct_branches",
  },
  // ... existing options (no-ide, no-attach, profile)
],
```

Replace `const cwd = process.cwd();` with:

```ts
const cwd = yield* resolveWorktreePath({
  path: options?.path,
  branch: options?.branch,
});
```

Add import:

```ts
import { resolveWorktreePath } from "./resolve-worktree-path";
```

Update the `getMainRepoPath` and `getCurrentBranch` calls to pass `cwd`:

```ts
const [mainRepoPath, branch] = yield* Effect.all([
  WorktreeService.use((service) => service.getMainRepoPath(cwd)),
  WorktreeService.use((service) => service.getCurrentBranch(cwd)),
]);
```

- [ ] **Step 4: Update `root-command.ts` to wire the new flags**

In `root-command.ts`, update `upCliCommand`:

```ts
const upCliCommand = Command.make(
  "up",
  {
    noIde: booleanFlag("no-ide", "Skip opening IDE"),
    noAttach: booleanFlag("no-attach", "Do not attach to tmux outside tmux"),
    profile: optionalStringFlag(
      "profile",
      "Use a named config profile",
      "P",
      "NAME",
    ),
    path: optionalStringFlag("path", "Path to worktree directory"),
    branch: optionalStringFlag(
      "branch",
      "Branch name to resolve worktree from",
      "b",
      "NAME",
    ),
  },
  ({ noIde, noAttach, profile, path, branch }) =>
    upCommand({
      noIde,
      noAttach,
      profile: optionToUndefined(profile),
      path: optionToUndefined(path),
      branch: optionToUndefined(branch),
    }),
).pipe(
  Command.withDescription(
    "Start tmux session and open IDE in current directory",
  ),
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test tests/up.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/up.ts src/cli/root-command.ts tests/up.test.ts
git commit -m "feat: add --path and --branch flags to up command (#53)"
```

---

### Task 4: Add `--path`/`--branch` flags to `down` command

**Files:**
- Modify: `src/commands/down.ts`
- Modify: `src/cli/root-command.ts`
- Modify: `tests/down.test.ts`

- [ ] **Step 1: Write failing test for `--path` flag in `downCommand`**

Update `tests/down.test.ts` — modify `runCommand` to accept options:

```ts
import { type DownOptions, downCommand } from "../src/commands/down";

async function runCommand(
  options?: DownOptions,
  overrides: { tmux?: TmuxService; worktree?: WorktreeService } = {},
) {
  await runBunPromise(withTestServices(downCommand(options), overrides));
}
```

Add test:

```ts
test("kills tmux session for worktree specified by --path", async () => {
  const killCalls: string[] = [];
  const pathOverrides: TmuxService = {
    ...liveTmuxService,
    sessionExists: () => Effect.succeed(true),
    killSession: (name: string) =>
      Effect.sync(() => {
        killCalls.push(name);
      }),
  };
  const worktreeOverrides: WorktreeService = {
    ...liveWorktreeService,
    isGitRepo: () => Effect.succeed(true),
  };

  await runCommand(
    { path: "/tmp/myproject-feature-x" },
    { tmux: pathOverrides, worktree: worktreeOverrides },
  );

  expect(killCalls).toEqual(["myproject-feature-x"]);
});
```

Add test for `--branch`:

```ts
test("kills tmux session for worktree resolved by --branch", async () => {
  const killCalls: string[] = [];
  const tmuxOverrides: TmuxService = {
    ...liveTmuxService,
    sessionExists: () => Effect.succeed(true),
    killSession: (name: string) =>
      Effect.sync(() => {
        killCalls.push(name);
      }),
  };
  const worktreeOverrides: WorktreeService = {
    ...liveWorktreeService,
    isGitRepo: () => Effect.succeed(true),
    listWorktrees: () =>
      Effect.succeed([
        {
          path: "/tmp/myproject-feat-y",
          branch: "feat-y",
          commit: "abc123",
          isBare: false,
        },
      ]),
  };

  await runCommand(
    { branch: "feat-y" },
    { tmux: tmuxOverrides, worktree: worktreeOverrides },
  );

  expect(killCalls).toEqual(["myproject-feat-y"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/down.test.ts`
Expected: FAIL — `DownOptions` does not exist.

- [ ] **Step 3: Update `down.ts` to accept `--path`/`--branch`**

```ts
// src/commands/down.ts
import { basename } from "node:path";
import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { formatSessionName, TmuxService } from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";
import { resolveWorktreePath } from "./resolve-worktree-path";

export const commandDef: CommandDef = {
  name: "down",
  description: "Kill tmux session for current directory",
  options: [
    {
      name: "path",
      type: "string",
      placeholder: "path",
      description: "Path to worktree directory",
    },
    {
      name: "branch",
      short: "b",
      type: "string",
      placeholder: "name",
      description: "Branch name to resolve worktree from",
      completionValues: "__wct_branches",
    },
  ],
};

export interface DownOptions {
  path?: string;
  branch?: string;
}

export function downCommand(
  options?: DownOptions,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const isRepo = yield* WorktreeService.use((service) => service.isGitRepo());
    if (!isRepo) {
      return yield* Effect.fail(
        commandError("not_git_repo", "Not a git repository"),
      );
    }

    const cwd = yield* resolveWorktreePath({
      path: options?.path,
      branch: options?.branch,
    });
    const sessionName = formatSessionName(basename(cwd));

    const exists = yield* TmuxService.use((service) =>
      service.sessionExists(sessionName),
    );
    if (!exists) {
      yield* logger.warn(`No tmux session '${sessionName}' found`);
      return;
    }

    yield* logger.info(`Killing tmux session '${sessionName}'...`);

    yield* TmuxService.use((service) => service.killSession(sessionName));

    yield* logger.success(`Killed tmux session '${sessionName}'`);
  });
}
```

- [ ] **Step 4: Update `root-command.ts` to wire `down` flags**

```ts
const downCliCommand = Command.make(
  "down",
  {
    path: optionalStringFlag("path", "Path to worktree directory"),
    branch: optionalStringFlag(
      "branch",
      "Branch name to resolve worktree from",
      "b",
      "NAME",
    ),
  },
  ({ path, branch }) =>
    downCommand({
      path: optionToUndefined(path),
      branch: optionToUndefined(branch),
    }),
).pipe(Command.withDescription("Kill tmux session for current directory"));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test tests/down.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/down.ts src/cli/root-command.ts tests/down.test.ts
git commit -m "feat: add --path and --branch flags to down command (#53)"
```

---

### Task 5: Add `ConfirmDown` mode and `d` keybinding in TUI

**Files:**
- Modify: `src/tui/types.ts`
- Modify: `src/tui/components/StatusBar.tsx`
- Modify: `src/tui/App.tsx`
- Modify: `tests/tui/status-bar.test.tsx`

- [ ] **Step 1: Write failing test for `ConfirmDown` status bar rendering**

Add to `tests/tui/status-bar.test.tsx`:

```tsx
test("shows the down confirmation prompt", async () => {
  const rendered = await renderStatusBar({
    mode: Mode.ConfirmDown("myapp-feature", "feature", "proj/feature"),
  });

  expect(rendered.output).toContain("Kill session for feature?");
  expect(rendered.output).toContain("enter:confirm  esc:cancel");

  rendered.unmount();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/tui/status-bar.test.tsx`
Expected: FAIL — `Mode.ConfirmDown` does not exist.

- [ ] **Step 3: Add `ConfirmDown` mode variant to `types.ts`**

In `src/tui/types.ts`, add to the `Mode` union:

```ts
| {
    type: "ConfirmDown";
    sessionName: string;
    branch: string;
    worktreeKey: string;
  }
```

Add the constructor to the `Mode` namespace:

```ts
ConfirmDown: (sessionName: string, branch: string, worktreeKey: string): Mode => ({
  type: "ConfirmDown",
  sessionName,
  branch,
  worktreeKey,
}),
```

- [ ] **Step 4: Update `StatusBar.tsx` to handle `ConfirmDown`**

In `getHints`, add a case:

```ts
case "ConfirmDown":
  return [`Kill session for ${mode.branch}?`, "enter:confirm  esc:cancel"];
```

In the `StatusBar` component, update the ConfirmKill rendering block to also handle ConfirmDown:

```tsx
if (mode.type === "ConfirmKill" || mode.type === "ConfirmDown") {
```

- [ ] **Step 5: Add `u:up` and `d:down` hints to Navigate and Expanded status bar**

In `getHints`, update the Navigate case:

```ts
case "Navigate":
  return [
    "↑↓:navigate  ←→:expand/collapse  space:switch  o:open",
    "u:up  d:down  c:close  /:search  q:quit",
  ];
```

Update the Expanded non-pane case:

```ts
return [
  "↑↓:navigate  ←:collapse  space:action  o:open",
  "u:up  d:down  c:close  /:search  q:quit",
];
```

- [ ] **Step 6: Update status bar tests for new hints**

Update existing tests in `tests/tui/status-bar.test.tsx` that check Navigate/Expanded hints to expect the new `u:up  d:down` text. For example, update the "shows generic expanded hints" test:

```tsx
expect(rendered.output).toContain("u:up  d:down  c:close  /:search  q:quit");
```

- [ ] **Step 7: Wire `d` key and `ConfirmDown` handling in `App.tsx`**

Add `handleDownSelectedWorktree` function in `App.tsx`:

```tsx
function handleDownSelectedWorktree() {
  const worktreeIndex = resolveSelectedWorktreeIndex(treeItems, selectedIndex);
  if (worktreeIndex === null) return;

  const item = treeItems[worktreeIndex];
  if (!item || item.type !== "worktree") return;

  const repo = filteredRepos[item.repoIndex];
  const wt = repo?.worktrees[item.worktreeIndex];
  if (!repo || !wt) return;

  const sessionName = formatSessionName(basename(wt.path));
  const hasSession = sessions.some((s) => s.name === sessionName);
  if (!hasSession) return;

  const worktreeKey = pendingKey(repo.project, wt.branch);
  setMode(Mode.ConfirmDown(sessionName, wt.branch, worktreeKey));
}
```

In `handleNavigateInput`, add before the `if (input === "c")` block:

```tsx
if (input === "d") {
  handleDownSelectedWorktree();
  return;
}
```

In `handleExpandedInput`, add before the `if (input === "c")` block:

```tsx
if (input === "d") {
  handleDownSelectedWorktree();
  return;
}
```

Add `handleConfirmDownInput` function:

```tsx
function handleConfirmDownInput(_input: string, key: Key) {
  if (mode.type !== "ConfirmDown") return;

  if (key.escape) {
    setMode(Mode.Navigate);
    return;
  }

  if (key.return) {
    const { sessionName, branch, worktreeKey } = mode;
    setMode(Mode.Navigate);

    const project = worktreeKey.split("/")[0] ?? "unknown";
    setPendingActions((prev) =>
      new Map(prev).set(worktreeKey, {
        type: "stopping",
        branch,
        project,
      }),
    );

    const worktreeIndex = resolveSelectedWorktreeIndex(treeItems, selectedIndex);
    const item = worktreeIndex !== null ? treeItems[worktreeIndex] : null;
    const repo = item && item.type === "worktree" ? filteredRepos[item.repoIndex] : null;
    const wt = item && item.type === "worktree" && repo ? repo.worktrees[item.worktreeIndex] : null;

    const proc = Bun.spawn(
      ["wct", "down", "--path", wt?.path ?? sessionName],
      { stdout: "ignore", stderr: "ignore" },
    );
    proc.exited.then(() => {
      refreshAll().then(() => {
        setPendingActions((prev) => {
          const next = new Map(prev);
          next.delete(worktreeKey);
          return next;
        });
      });
    });
  }
}
```

Wire it in the `useInput` switch:

```tsx
case "ConfirmDown":
  return handleConfirmDownInput(input, key);
```

Update the `q` key guard to also exclude `ConfirmDown`:

```tsx
if (
  input === "q" &&
  mode.type !== "OpenModal" &&
  mode.type !== "Search" &&
  mode.type !== "ConfirmKill" &&
  mode.type !== "ConfirmDown" &&
  mode.type !== "UpModal"
) {
```

- [ ] **Step 8: Add `"stopping"` to `PendingAction` type**

In `src/tui/types.ts`, update the `PendingAction` type:

```ts
export interface PendingAction {
  type: "opening" | "closing" | "starting" | "stopping";
  branch: string;
  project: string;
}
```

- [ ] **Step 9: Run all tests**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 10: Commit**

```bash
git add src/tui/types.ts src/tui/components/StatusBar.tsx src/tui/App.tsx tests/tui/status-bar.test.tsx
git commit -m "feat: add d:down keybinding with ConfirmDown mode in TUI (#54)"
```

---

### Task 6: Add `UpModal` component and `u` keybinding in TUI

**Files:**
- Create: `src/tui/components/UpModal.tsx`
- Modify: `src/tui/types.ts`
- Modify: `src/tui/App.tsx`

- [ ] **Step 1: Add `UpModal` mode variant to `types.ts`**

Add to the `Mode` union:

```ts
| {
    type: "UpModal";
    worktreePath: string;
    worktreeKey: string;
    profileNames: string[];
  }
```

Add the constructor:

```ts
UpModal: (worktreePath: string, worktreeKey: string, profileNames: string[]): Mode => ({
  type: "UpModal",
  worktreePath,
  worktreeKey,
  profileNames,
}),
```

- [ ] **Step 2: Create `UpModal.tsx`**

```tsx
// src/tui/components/UpModal.tsx
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { SubmitButton, ToggleRow } from "./form-controls";
import { Modal } from "./Modal";
import { ScrollableList, type ListItem, filterItems } from "./ScrollableList";
import { TitledBox } from "./TitledBox";

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

type UpField = "profile" | "noIde" | "autoSwitch" | "submit";

export function UpModal({
  visible,
  width,
  profileNames,
  onSubmit,
  onCancel,
}: UpModalProps) {
  const [profileIndex, setProfileIndex] = useState(0);
  const [profileFilter, setProfileFilter] = useState("");
  const [noIde, setNoIde] = useState(false);
  const [autoSwitch, setAutoSwitch] = useState(true);

  const hasProfiles = profileNames.length > 0;

  const fields = useMemo(() => {
    const f: UpField[] = [];
    if (hasProfiles) f.push("profile");
    f.push("noIde", "autoSwitch", "submit");
    return f;
  }, [hasProfiles]);

  const [focusIndex, setFocusIndex] = useState(0);
  const currentField = fields[focusIndex];

  const profileItems: ListItem[] = useMemo(
    () => [
      { label: "(default)", value: "" },
      ...profileNames.map((p) => ({ label: p, value: p })),
    ],
    [profileNames],
  );

  const filteredProfileItems = useMemo(
    () => filterItems(profileItems, profileFilter),
    [profileItems, profileFilter],
  );

  const moveFocus = (delta: number) => {
    setFocusIndex((prev) => (prev + delta + fields.length) % fields.length);
  };

  const submit = () => {
    const selected = filteredProfileItems[profileIndex];
    onSubmit({
      profile: selected?.value || undefined,
      noIde,
      autoSwitch,
    });
  };

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.tab) {
        moveFocus(key.shift ? -1 : 1);
        return;
      }
      if (currentField === "profile") {
        if (key.upArrow) {
          setProfileIndex((s) => Math.max(0, s - 1));
          return;
        }
        if (key.downArrow) {
          setProfileIndex((s) =>
            Math.min(filteredProfileItems.length - 1, s + 1),
          );
          return;
        }
        if (key.backspace || key.delete) {
          setProfileFilter((q) => q.slice(0, -1));
          setProfileIndex(0);
          return;
        }
        if (_input && !key.ctrl && !key.meta && !key.return) {
          setProfileFilter((q) => q + _input);
          setProfileIndex(0);
          return;
        }
      }
    },
    { isActive: visible },
  );

  if (!visible) return null;

  const innerWidth = width === undefined ? undefined : Math.max(width - 2, 0);

  return (
    <Modal title="Start Session" visible={visible} width={width}>
      <Box flexDirection="column" gap={0}>
        {hasProfiles && (
          <TitledBox
            title="Profile"
            isFocused={currentField === "profile"}
            width={innerWidth}
          >
            <ScrollableList
              items={profileItems}
              selectedIndex={profileIndex}
              filterQuery={profileFilter}
              maxVisible={6}
              isFocused={currentField === "profile"}
            />
          </TitledBox>
        )}
        <ToggleRow
          label="No IDE"
          checked={noIde}
          isFocused={currentField === "noIde"}
          onToggle={() => setNoIde((v) => !v)}
        />
        <ToggleRow
          label="Auto-switch"
          checked={autoSwitch}
          isFocused={currentField === "autoSwitch"}
          onToggle={() => setAutoSwitch((v) => !v)}
        />
        <SubmitButton isFocused={currentField === "submit"} onSubmit={submit} />
        <Box marginTop={1}>
          <Text dimColor>tab:next  shift+tab:prev  esc:cancel</Text>
        </Box>
      </Box>
    </Modal>
  );
}
```

- [ ] **Step 3: Wire `u` key and `UpModal` handling in `App.tsx`**

Add import:

```tsx
import { UpModal, type UpModalResult } from "./components/UpModal";
```

Add `prepareUpModal` function:

```tsx
function prepareUpModal() {
  const worktreeIndex = resolveSelectedWorktreeIndex(treeItems, selectedIndex);
  if (worktreeIndex === null) return;

  const item = treeItems[worktreeIndex];
  if (!item || item.type !== "worktree") return;

  const repo = filteredRepos[item.repoIndex];
  const wt = repo?.worktrees[item.worktreeIndex];
  if (!repo || !wt) return;

  const worktreeKey = pendingKey(repo.project, wt.branch);
  setMode(Mode.UpModal(wt.path, worktreeKey, repo.profileNames));
}
```

Add `handleUpSubmit` function:

```tsx
function handleUpSubmit(result: UpModalResult) {
  if (mode.type !== "UpModal") return;

  const { worktreePath, worktreeKey } = mode;
  setMode(Mode.Navigate);

  const branch = worktreeKey.split("/").slice(1).join("/");
  const project = worktreeKey.split("/")[0] ?? "unknown";
  setPendingActions((prev) =>
    new Map(prev).set(worktreeKey, {
      type: "starting",
      branch,
      project,
    }),
  );

  const args = ["up", "--no-attach", "--path", worktreePath];
  if (result.profile) args.push("--profile", result.profile);
  if (result.noIde) args.push("--no-ide");

  const proc = Bun.spawn(["wct", ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.exited.then(async (code) => {
    if (code === 0 && result.autoSwitch) {
      await refreshSessions();
      const sessionName = formatSessionName(basename(worktreePath));
      switchSession(sessionName);
    } else {
      await refreshAll();
    }
    setPendingActions((prev) => {
      const next = new Map(prev);
      next.delete(worktreeKey);
      return next;
    });
  });
}
```

In `handleNavigateInput`, add before the `if (input === "c")` block:

```tsx
if (input === "u") {
  prepareUpModal();
  return;
}
```

In `handleExpandedInput`, add before the `if (input === "c")` block:

```tsx
if (input === "u") {
  prepareUpModal();
  return;
}
```

In the `useInput` switch, add:

```tsx
case "UpModal":
  // Modal handles its own input
  return;
```

In the JSX, render `UpModal` alongside `OpenModal`:

```tsx
{mode.type === "UpModal" ? (
  <UpModal
    visible
    width={Math.min(termCols, 60)}
    profileNames={mode.profileNames}
    onSubmit={handleUpSubmit}
    onCancel={() => setMode(Mode.Navigate)}
  />
) : mode.type === "OpenModal" ? (
  <OpenModal
    visible
    width={Math.min(termCols, 60)}
    defaultBase={openModalBase ?? ""}
    profileNames={openModalProfiles}
    repoProject={openModalRepoProject}
    repoPath={openModalRepoPath}
    prList={openModalPRList}
    onSubmit={handleOpen}
    onCancel={() => setMode(Mode.Navigate)}
  />
) : (
  <StatusBar {...statusBarProps} searchQuery={searchQuery} />
)}
```

Also add `"UpModal"` to the `expandedWorktreeKey` check:

```tsx
const expandedWorktreeKey =
  mode.type === "Expanded" || mode.type === "ConfirmKill" || mode.type === "ConfirmDown"
    ? mode.worktreeKey
    : null;
```

- [ ] **Step 4: Run all tests**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/UpModal.tsx src/tui/types.ts src/tui/App.tsx
git commit -m "feat: add u:up keybinding with UpModal in TUI (#54)"
```

---

### Task 7: Close issues

- [ ] **Step 1: Close GitHub issues**

```bash
gh issue close 53 --comment "Implemented --path and --branch flags for up/down commands"
gh issue close 54 --comment "Implemented u:up and d:down keybindings in TUI"
```

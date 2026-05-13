# Configurable IDE Open Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change IDE launching so no config means no IDE by default, `ide.open` controls default IDE launch behavior, CLI/TUI choices override config, and the fallback IDE command is used only when forcing IDE open without a configured command.

**Architecture:** Represent IDE config as an optional object with `open?: boolean`, `command?: string`, and existing metadata fields. Merge global, project, and profile IDE objects field-by-field so `open` can be overridden independently from `command` and `fork_workspace`. Route all launch decisions through one small helper that turns resolved config plus CLI/TUI overrides into a final IDE command and workspace-sync decision.

**Tech Stack:** Bun, TypeScript, Effect v4, Effect Schema, Ink/React TUI, Vitest via automatic hooks only.

---

## Files

- Modify: `src/config/schema.ts` - make `ide.command` optional and add `ide.open`.
- Modify: `src/config/loader.ts` - separate `DEFAULT_IDE_CONFIG`, remove IDE from `DEFAULT_CONFIG`, add IDE merge helpers, and merge profile IDE config consistently.
- Modify: `src/config/validator.ts` - keep resolved config behavior compatible with optional IDE command.
- Modify: `src/commands/open.ts` - add `ide?: boolean`, validate flag conflicts, use final IDE decision for workspace sync and launch.
- Modify: `src/commands/worktree-session.ts` - add `ide?: boolean`, validate flag conflicts, use final IDE decision for `wct up`.
- Modify: `src/commands/up.ts` - expose the positive `--ide` option and pass it through.
- Modify: `src/cli/root-command.ts` - add `--ide` to `open` and `up`, update descriptions.
- Modify: `src/commands/init.ts` - add `open: true` to generated IDE config.
- Modify: `src/commands/command-def.ts` only if the existing metadata type needs no changes after adding boolean options.
- Modify: `src/tui/hooks/useRegistry.ts` - load derived IDE defaults per repo and per profile.
- Modify: `src/tui/hooks/useSessionOptionsState.ts` - default and reset `noIde` from effective profile selection.
- Modify: `src/tui/components/SessionOptionsSection.tsx` - pass profile selection into parent before defaulting `noIde`.
- Modify: `src/tui/components/UpModal.tsx` - accept IDE defaults and keep “No IDE” checkbox.
- Modify: `src/tui/components/OpenModal.tsx` - accept IDE defaults and apply them in all three forms.
- Modify: `src/tui/App.tsx`, `src/tui/types.ts`, `src/tui/hooks/useModalActions.ts` - pass repo/profile IDE defaults into modals and convert unchecked “No IDE” into force-IDE behavior when config default is no IDE.
- Modify: `src/cli/completions.ts` only through existing command metadata flow if completion tests show hardcoded expected flags need updates.
- Test: `tests/config.test.ts`, `tests/profile.test.ts`, `tests/open.test.ts`, `tests/worktree-session.test.ts`, `tests/up.test.ts`, `tests/completions.test.ts`, `tests/tui/use-registry.test.ts`, `tests/tui/session-options.test.ts`, `tests/tui/up-modal.test.tsx`, `tests/tui/open-modal.test.tsx`, `tests/tui/modal-actions.test.ts`.

## Verification Rule

Do not run tests or linting manually in this repo. The project hooks run `biome format --write` after file edits and run `biome lint --write` plus `bun run test` when the session stops. In this plan, every “verify” step means: save the change and rely on the hooks; expected final hook result is `bun run test` PASS.

---

### Task 1: Update IDE Config Shape And Defaults

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing schema/default tests**

Add or update tests in `tests/config.test.ts`:

```ts
test("accepts ide config with open false and no command", () => {
  const result = validateConfig({
    ide: {
      open: false,
    },
  });
  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test("accepts ide config with open true and no command", () => {
  const result = validateConfig({
    ide: {
      open: true,
    },
  });
  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test("rejects non-boolean ide.open", () => {
  const result = validateConfig({
    ide: {
      open: "yes",
    },
  });
  expect(result.valid).toBe(false);
  expectValidationError(result.errors, "ide.open: Expected boolean");
});
```

Replace the current `DEFAULT_CONFIG` IDE expectations:

```ts
describe("DEFAULT_CONFIG", () => {
  test("uses parent directory as worktree_dir", () => {
    expect(DEFAULT_CONFIG.worktree_dir).toBe("..");
  });

  test("does not include an IDE by default", () => {
    expect(DEFAULT_CONFIG.ide).toBeUndefined();
  });

  test("exports a fallback IDE command for explicit force-open behavior", () => {
    expect(DEFAULT_IDE_CONFIG.command).toBe("code $WCT_WORKTREE_DIR");
  });

  test("creates a single empty tmux window by default", () => {
    expect(DEFAULT_CONFIG.tmux?.windows).toHaveLength(1);
    expect(DEFAULT_CONFIG.tmux?.windows?.[0]?.name).toBe("main");
    expect(DEFAULT_CONFIG.tmux?.windows?.[0]?.command).toBeUndefined();
  });

  test("loadConfig returns default config without IDE when no config files are present", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "wct-config-test-"));
    const result = await loadConfig(projectDir);

    expect(result.config).not.toBeNull();
    expect(result.config?.worktree_dir).toBe(DEFAULT_CONFIG.worktree_dir);
    expect(result.config?.ide).toBeUndefined();
    expect(result.config?.tmux?.windows).toHaveLength(1);
    expect(result.config?.tmux?.windows?.[0]?.name).toBe(
      DEFAULT_CONFIG.tmux?.windows?.[0]?.name,
    );
    expect(result.config?.tmux?.windows?.[0]?.command).toBeUndefined();
  });
});
```

Update the import at the top of `tests/config.test.ts`:

```ts
import {
  DEFAULT_CONFIG,
  DEFAULT_IDE_CONFIG,
  expandTilde,
  loadConfig,
  resolveWorktreePath,
  slugifyBranch,
} from "../src/config/loader";
```

- [ ] **Step 2: Let hooks verify the tests fail**

Do not run tests manually. Expected hook result before implementation: config tests fail because `ide.open` is not in the schema, `ide.command` is required, and `DEFAULT_IDE_CONFIG` is not exported.

- [ ] **Step 3: Implement schema and default constant**

Change `src/config/schema.ts`:

```ts
export const IdeConfigSchema = Schema.Struct({
  open: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  fork_workspace: Schema.optional(Schema.Boolean),
});
```

Change the defaults in `src/config/loader.ts`:

```ts
export const DEFAULT_IDE_CONFIG = {
  command: "code $WCT_WORKTREE_DIR",
} satisfies NonNullable<WctConfig["ide"]>;

const DEFAULT_CONFIG: WctConfig = {
  worktree_dir: "..",
  tmux: { windows: [{ name: "main" }] },
};
```

Keep the existing bottom export, but include `DEFAULT_IDE_CONFIG`:

```ts
export { CONFIG_FILENAME, DEFAULT_CONFIG, DEFAULT_IDE_CONFIG };
```

- [ ] **Step 4: Let hooks verify Task 1**

Do not run tests manually. Expected final hook result for this task: schema/default tests pass, with any unrelated failures handled in later tasks.

- [ ] **Step 5: Commit Task 1**

Use the approved commit workflow:

```bash
git add -A
git commit -m "feat: make ide command optional"
```

---

### Task 2: Merge IDE Config Objects Consistently

**Files:**
- Modify: `src/config/loader.ts`
- Test: `tests/config.test.ts`
- Test: `tests/profile.test.ts`

- [ ] **Step 1: Write failing merge tests**

Add tests in `tests/config.test.ts` for global/project merge through `loadConfig`. Use the existing temp-dir style:

```ts
test("project ide.open overrides global ide command without discarding command", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wct-config-project-"));
  const homeDir = mkdtempSync(join(tmpdir(), "wct-config-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    await Bun.write(
      join(homeDir, ".wct.yaml"),
      `ide:
  command: "cursor $WCT_WORKTREE_DIR"
  fork_workspace: true
`,
    );
    await Bun.write(
      join(projectDir, ".wct.yaml"),
      `ide:
  open: false
`,
    );

    const result = await loadConfig(projectDir);

    expect(result.config?.ide).toEqual({
      command: "cursor $WCT_WORKTREE_DIR",
      fork_workspace: true,
      open: false,
    });
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});
```

Add profile merge tests in `tests/profile.test.ts`:

```ts
test("profile ide.open overrides base ide without discarding command", () => {
  const config = baseConfig({
    ide: {
      name: "vscode",
      command: "code $WCT_WORKTREE_DIR",
      fork_workspace: true,
    },
    profiles: {
      quiet: {
        ide: { open: false },
      },
    },
  });

  const { config: result } = resolveProfile(config, "any-branch", "quiet");

  expect(result.ide).toEqual({
    name: "vscode",
    command: "code $WCT_WORKTREE_DIR",
    fork_workspace: true,
    open: false,
  });
});

test("profile ide command overrides base command and inherits open flag", () => {
  const config = baseConfig({
    ide: {
      open: false,
      command: "code $WCT_WORKTREE_DIR",
    },
    profiles: {
      cursor: {
        ide: { command: "cursor $WCT_WORKTREE_DIR" },
      },
    },
  });

  const { config: result } = resolveProfile(config, "any-branch", "cursor");

  expect(result.ide).toEqual({
    open: false,
    command: "cursor $WCT_WORKTREE_DIR",
  });
});
```

- [ ] **Step 2: Let hooks verify the tests fail**

Do not run tests manually. Expected hook result before implementation: project/profile IDE objects replace instead of merge.

- [ ] **Step 3: Implement IDE object merge**

In `src/config/loader.ts`, add:

```ts
function mergeIdeConfig(
  base: WctConfig["ide"] | undefined,
  override: WctConfig["ide"] | undefined,
): WctConfig["ide"] | undefined {
  if (!base) return override;
  if (!override) return base;
  return {
    ...base,
    ...override,
  };
}
```

Update `mergeConfigs`:

```ts
ide: mergeIdeConfig(global.ide, project.ide),
```

Update `applyProfile`:

```ts
ide: mergeIdeConfig(base.ide, profile.ide),
```

- [ ] **Step 4: Let hooks verify Task 2**

Do not run tests manually. Expected final hook result for this task: config/profile merge tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add -A
git commit -m "feat: merge ide config fields"
```

---

### Task 3: Centralize IDE Launch Decision

**Files:**
- Modify: `src/config/loader.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing launch-decision tests**

Add tests in `tests/config.test.ts`:

```ts
describe("resolveIdeLaunch", () => {
  test("skips IDE when no config and no force flag are present", () => {
    expect(resolveIdeLaunch(undefined, {})).toEqual({
      open: false,
      command: undefined,
      config: undefined,
    });
  });

  test("opens fallback IDE when force flag is true and no config exists", () => {
    expect(resolveIdeLaunch(undefined, { ide: true })).toEqual({
      open: true,
      command: DEFAULT_IDE_CONFIG.command,
      config: DEFAULT_IDE_CONFIG,
    });
  });

  test("opens configured IDE by default when ide object exists", () => {
    const config = { command: "cursor $WCT_WORKTREE_DIR" };
    expect(resolveIdeLaunch(config, {})).toEqual({
      open: true,
      command: "cursor $WCT_WORKTREE_DIR",
      config,
    });
  });

  test("skips configured IDE when open is false", () => {
    const config = { open: false, command: "cursor $WCT_WORKTREE_DIR" };
    expect(resolveIdeLaunch(config, {})).toEqual({
      open: false,
      command: "cursor $WCT_WORKTREE_DIR",
      config,
    });
  });

  test("force flag opens configured command even when open is false", () => {
    const config = { open: false, command: "cursor $WCT_WORKTREE_DIR" };
    expect(resolveIdeLaunch(config, { ide: true })).toEqual({
      open: true,
      command: "cursor $WCT_WORKTREE_DIR",
      config,
    });
  });

  test("force flag uses fallback command when config has open false but no command", () => {
    const config = { open: false };
    expect(resolveIdeLaunch(config, { ide: true })).toEqual({
      open: true,
      command: DEFAULT_IDE_CONFIG.command,
      config: { ...DEFAULT_IDE_CONFIG, open: false },
    });
  });

  test("noIde flag skips even configured IDE", () => {
    const config = { command: "cursor $WCT_WORKTREE_DIR" };
    expect(resolveIdeLaunch(config, { noIde: true })).toEqual({
      open: false,
      command: "cursor $WCT_WORKTREE_DIR",
      config,
    });
  });
});
```

Update the import:

```ts
import {
  DEFAULT_CONFIG,
  DEFAULT_IDE_CONFIG,
  expandTilde,
  loadConfig,
  resolveIdeLaunch,
  resolveWorktreePath,
  slugifyBranch,
} from "../src/config/loader";
```

- [ ] **Step 2: Let hooks verify the tests fail**

Do not run tests manually. Expected hook result before implementation: `resolveIdeLaunch` does not exist.

- [ ] **Step 3: Implement `resolveIdeLaunch`**

Add to `src/config/loader.ts`:

```ts
export interface IdeLaunchOptions {
  ide?: boolean;
  noIde?: boolean;
}

export interface ResolvedIdeLaunch {
  open: boolean;
  command: string | undefined;
  config: WctConfig["ide"] | undefined;
}

export function resolveIdeLaunch(
  ideConfig: WctConfig["ide"] | undefined,
  options: IdeLaunchOptions,
): ResolvedIdeLaunch {
  const mergedConfig = ideConfig?.command
    ? ideConfig
    : ideConfig
      ? { ...DEFAULT_IDE_CONFIG, ...ideConfig }
      : undefined;

  if (options.noIde) {
    return {
      open: false,
      command: mergedConfig?.command,
      config: mergedConfig,
    };
  }

  if (options.ide) {
    const config = mergedConfig ?? DEFAULT_IDE_CONFIG;
    return {
      open: true,
      command: config.command,
      config,
    };
  }

  if (!mergedConfig) {
    return {
      open: false,
      command: undefined,
      config: undefined,
    };
  }

  const open = mergedConfig.open ?? true;
  return {
    open,
    command: mergedConfig.command,
    config: mergedConfig,
  };
}
```

- [ ] **Step 4: Let hooks verify Task 3**

Do not run tests manually. Expected final hook result for this task: launch-decision tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add -A
git commit -m "feat: resolve ide launch decisions"
```

---

### Task 4: Add CLI Override Semantics To `wct open`

**Files:**
- Modify: `src/commands/open.ts`
- Modify: `src/cli/root-command.ts`
- Test: `tests/open.test.ts`

- [ ] **Step 1: Write failing open-option tests**

Add to `tests/open.test.ts` under `describe("resolveOpenOptions", ...)`:

```ts
test("rejects --ide together with --no-ide", async () => {
  await expect(
    runResolveOpenOptions({
      branch: "feature-branch",
      ide: true,
      noIde: true,
    }),
  ).rejects.toThrow("Options --ide and --no-ide cannot be used together");
});

test("passes through positive ide flag", async () => {
  await expect(
    runResolveOpenOptions({
      branch: "feature-branch",
      ide: true,
    }),
  ).resolves.toMatchObject({
    ide: true,
    noIde: false,
  });
});
```

Update the existing exact PR normalization expectation in `tests/open.test.ts` to include the new normalized `ide` boolean:

```ts
await expect(
  runResolveOpenOptions(
    {
      cwd: "/repo",
      pr: "123",
      noIde: true,
      prompt: "focus",
      profile: "default",
    },
    {
      github: githubOverrides,
      worktree: worktreeOverrides,
    },
  ),
).resolves.toEqual({
  branch: "feature-from-pr",
  existing: false,
  base: "origin/feature-from-pr",
  cwd: "/repo",
  ide: false,
  noIde: true,
  prompt: "focus",
  profile: "default",
});
```

- [ ] **Step 2: Write failing open launch behavior tests**

In `tests/open.test.ts`, add a workflow test using the existing fixture style:

```ts
test("does not open IDE by default when config omits ide", async () => {
  const fixture = await createOpenWorkflowFixture();
  const ideCalls: string[] = [];
  const originalCwd = process.cwd();
  process.chdir(fixture.repoDir);
  try {
    const options = await runResolveOpenOptions({
      branch: "feature-no-ide",
      cwd: fixture.repoDir,
    });

    await runBunPromise(
      withTestServices(openWorktree(options), {
        ide: {
          openIDE: (command) =>
            Effect.sync(() => {
              ideCalls.push(command);
            }),
        },
      }),
    );

    expect(ideCalls).toEqual([]);
  } finally {
    process.chdir(originalCwd);
    await cleanupOpenWorkflowFixture(fixture);
  }
});

test("opens fallback IDE when --ide is passed and config omits ide", async () => {
  const fixture = await createOpenWorkflowFixture();
  const ideCalls: string[] = [];
  const originalCwd = process.cwd();
  process.chdir(fixture.repoDir);
  try {
    const options = await runResolveOpenOptions({
      branch: "feature-force-ide",
      cwd: fixture.repoDir,
      ide: true,
    });

    await runBunPromise(
      withTestServices(openWorktree(options), {
        ide: {
          openIDE: (command) =>
            Effect.sync(() => {
              ideCalls.push(command);
            }),
        },
      }),
    );

    expect(ideCalls).toEqual([DEFAULT_IDE_CONFIG.command]);
  } finally {
    process.chdir(originalCwd);
    await cleanupOpenWorkflowFixture(fixture);
  }
});
```

Add `DEFAULT_IDE_CONFIG` to the loader import in this test.

- [ ] **Step 3: Let hooks verify the tests fail**

Do not run tests manually. Expected hook result before implementation: `ide` is not accepted and no-config open still uses the old default IDE behavior.

- [ ] **Step 4: Add `ide` option and conflict validation**

In `src/commands/open.ts`, add `ide` to `commandDef.options`:

```ts
{
  name: "ide",
  type: "boolean",
  description: "Force opening IDE",
},
```

Update interfaces:

```ts
export interface OpenOptions {
  branch: string;
  existing: boolean;
  base?: string;
  cwd?: string;
  ide: boolean;
  noIde: boolean;
  pr?: string;
  prompt?: string;
  profile?: string;
}

export interface OpenRequest {
  branch?: string;
  existing?: boolean;
  base?: string;
  cwd?: string;
  ide?: boolean;
  noIde?: boolean;
  pr?: string;
  prompt?: string;
  profile?: string;
}
```

At the start of `resolveOpenOptions`, default both booleans during destructuring:

```ts
const {
  branch,
  existing = false,
  base,
  cwd,
  ide = false,
  noIde = false,
  pr,
  prompt,
  profile,
} = input;
```

Then validate the conflict:

```ts
if (ide && noIde) {
  return yield* Effect.fail(
    commandError(
      "invalid_options",
      "Options --ide and --no-ide cannot be used together",
    ),
  );
}
```

Return both flags in both PR and non-PR return objects:

```ts
ide,
noIde,
```

In `src/cli/root-command.ts`, add `ide` to the `open` flags and handler:

```ts
ide: booleanFlag("ide", "Force opening IDE"),
noIde: booleanFlag("no-ide", "Skip opening IDE"),
```

Update the handler signature:

```ts
({ branch, base, existing, ide, noIde, noAttach, pr, prompt, profile }) =>
```

Pass it into `resolveOpenOptions`:

```ts
ide,
noIde,
```

- [ ] **Step 5: Use final IDE decision in open workflow**

In `src/commands/open.ts`, import:

```ts
import {
  DEFAULT_IDE_CONFIG,
  loadConfig,
  resolveIdeLaunch,
  resolveProfile,
  resolveWorktreePath,
} from "../config/loader";
```

At the top of `openWorktree`, include `ide` in the options destructure:

```ts
const { branch, existing, base, cwd, ide, noIde, prompt, profile } = options;
```

Then compute after profile resolution:

```ts
const ideLaunch = resolveIdeLaunch(resolved.ide, { ide, noIde });
```

Use it for VS Code workspace sync:

```ts
if (
  ideLaunch.open &&
  (ideLaunch.config?.name ?? "vscode") === "vscode" &&
  ideLaunch.config?.fork_workspace
) {
  // existing workspace sync block
}
```

Use it for launch:

```ts
const launchResult = yield* launchSessionAndIde({
  sessionName,
  workingDir: worktreePath,
  tmuxConfig: resolved.tmux,
  env,
  ideCommand: ideLaunch.open ? ideLaunch.command : undefined,
  noIde: false,
});
```

Remove now-unused `DEFAULT_IDE_CONFIG` import if Task 4 tests do not need it in source.

- [ ] **Step 6: Let hooks verify Task 4**

Do not run tests manually. Expected final hook result for this task: open option and launch tests pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add -A
git commit -m "feat: add ide override to open"
```

---

### Task 5: Add CLI Override Semantics To `wct up`

**Files:**
- Modify: `src/commands/worktree-session.ts`
- Modify: `src/commands/up.ts`
- Modify: `src/cli/root-command.ts`
- Test: `tests/worktree-session.test.ts`
- Test: `tests/up.test.ts`

- [ ] **Step 1: Write failing worktree-session tests**

Add to `tests/worktree-session.test.ts`:

```ts
test("rejects ide and noIde together", async () => {
  process.chdir(fixture.repoDir);

  await expect(
    runBunPromise(
      withTestServices(
        startWorktreeSession({
          path: wtPath,
          ide: true,
          noIde: true,
        }),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: (cwd?: string) => Effect.succeed(cwd === wtPath),
            getMainRepoPath: (cwd?: string) =>
              Effect.succeed(cwd === wtPath ? fixture.repoDir : null),
            getCurrentBranch: (cwd?: string) =>
              Effect.succeed(cwd === wtPath ? "feature-branch" : null),
          },
        },
      ),
    ),
  ).rejects.toThrow("Options --ide and --no-ide cannot be used together");
});

test("skips IDE by default when config omits ide", async () => {
  process.chdir(fixture.repoDir);
  await Bun.write(
    join(fixture.repoDir, ".wct.yaml"),
    `version: 1
worktree_dir: "worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
`,
  );

  const result = await runBunPromise(
    withTestServices(startWorktreeSession({ path: wtPath }), {
      worktree: {
        ...liveWorktreeService,
        isGitRepo: (cwd?: string) => Effect.succeed(cwd === wtPath),
        getMainRepoPath: (cwd?: string) =>
          Effect.succeed(cwd === wtPath ? fixture.repoDir : null),
        getCurrentBranch: (cwd?: string) =>
          Effect.succeed(cwd === wtPath ? "feature-branch" : null),
      },
    }),
  );

  expect(result.ide).toEqual({ attempted: false });
});

test("opens fallback IDE when ide flag is passed and config omits ide", async () => {
  process.chdir(fixture.repoDir);
  await Bun.write(
    join(fixture.repoDir, ".wct.yaml"),
    `version: 1
worktree_dir: "worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
`,
  );
  const ideCalls: string[] = [];

  const result = await runBunPromise(
    withTestServices(startWorktreeSession({ path: wtPath, ide: true }), {
      worktree: {
        ...liveWorktreeService,
        isGitRepo: (cwd?: string) => Effect.succeed(cwd === wtPath),
        getMainRepoPath: (cwd?: string) =>
          Effect.succeed(cwd === wtPath ? fixture.repoDir : null),
        getCurrentBranch: (cwd?: string) =>
          Effect.succeed(cwd === wtPath ? "feature-branch" : null),
      },
      ide: {
        openIDE: (command) =>
          Effect.sync(() => {
            ideCalls.push(command);
          }),
      },
    }),
  );

  expect(result.ide.attempted).toBe(true);
  expect(ideCalls).toEqual([DEFAULT_IDE_CONFIG.command]);
});
```

Add this import at the top of `tests/worktree-session.test.ts`:

```ts
import { DEFAULT_IDE_CONFIG } from "../src/config/loader";
```

- [ ] **Step 2: Let hooks verify the tests fail**

Do not run tests manually. Expected hook result before implementation: `StartWorktreeSessionOptions` has no `ide` flag and default IDE behavior is still config-driven by old default.

- [ ] **Step 3: Implement `wct up` IDE override**

In `src/commands/worktree-session.ts`, import `resolveIdeLaunch`:

```ts
import { loadConfig, resolveIdeLaunch, resolveProfile } from "../config/loader";
```

Add to `StartWorktreeSessionOptions`:

```ts
ide?: boolean;
```

Destructure and validate:

```ts
const { ide, noIde, profile, path, branch: branchOption } = options;

if (ide && noIde) {
  return yield* Effect.fail(
    commandError(
      "invalid_options",
      "Options --ide and --no-ide cannot be used together",
    ),
  );
}
```

Compute launch decision after profile resolution:

```ts
const ideLaunch = resolveIdeLaunch(resolved.ide, { ide, noIde });
```

Replace the IDE branch in `Effect.all`:

```ts
ideLaunch.open && ideLaunch.command
  ? captureAttempt(
      IdeService.use((service) => service.openIDE(ideLaunch.command ?? "", env)),
    )
  : Effect.succeed(skippedAttempt<void>()),
```

In `src/commands/up.ts`, add command metadata:

```ts
{
  name: "ide",
  type: "boolean",
  description: "Force opening IDE",
},
```

Add `ide?: boolean` to `UpOptions`, destructure it, and pass it into `startWorktreeSession`.

In `src/cli/root-command.ts`, add:

```ts
ide: booleanFlag("ide", "Force opening IDE"),
```

Update the `up` handler signature and call:

```ts
({ ide, noIde, noAttach, path, branch, profile }) =>
  upCommand({
    ide,
    noIde,
    noAttach,
    path: optionToUndefined(path),
    branch: optionToUndefined(branch),
    profile: optionToUndefined(profile),
  }),
```

- [ ] **Step 4: Let hooks verify Task 5**

Do not run tests manually. Expected final hook result for this task: worktree-session and up option tests pass.

- [ ] **Step 5: Commit Task 5**

```bash
git add -A
git commit -m "feat: add ide override to up"
```

---

### Task 6: Reflect IDE Config Defaults In TUI Registry Data

**Files:**
- Modify: `src/tui/hooks/useRegistry.ts`
- Test: `tests/tui/use-registry.test.ts`

- [ ] **Step 1: Write failing TUI registry tests**

In `tests/tui/use-registry.test.ts`, add a pure test for derived IDE defaults. First import the helper that will be created:

```ts
import { getIdeDefaults } from "../../src/tui/hooks/useRegistry";
```

Add tests:

```ts
describe("getIdeDefaults", () => {
  test("defaults to no IDE when config cannot be loaded", async () => {
    await withIsolatedHome(async () => {
      await expect(getIdeDefaults("/missing")).resolves.toEqual({
        baseNoIde: true,
        profileNoIde: {},
      });
    });
  });

  test("base config with ide object defaults No IDE unchecked", async () => {
    await withConfigFixture(`ide:
  command: "cursor $WCT_WORKTREE_DIR"
`, async (repoPath) => {
      await expect(getIdeDefaults(repoPath)).resolves.toEqual({
        baseNoIde: false,
        profileNoIde: {},
      });
    });
  });

  test("profile ide.open false defaults No IDE checked for that profile", async () => {
    await withConfigFixture(`ide:
  command: "cursor $WCT_WORKTREE_DIR"
profiles:
  quiet:
    ide:
      open: false
`, async (repoPath) => {
      await expect(getIdeDefaults(repoPath)).resolves.toEqual({
        baseNoIde: false,
        profileNoIde: {
          quiet: true,
        },
      });
    });
  });

  test("profile ide object defaults No IDE unchecked when base has no ide", async () => {
    await withConfigFixture(`profiles:
  cursor:
    ide:
      command: "cursor $WCT_WORKTREE_DIR"
`, async (repoPath) => {
      await expect(getIdeDefaults(repoPath)).resolves.toEqual({
        baseNoIde: true,
        profileNoIde: {
          cursor: false,
        },
      });
    });
  });
});
```

Add this test helper in the same file:

```ts
async function withIsolatedHome(run: () => Promise<void>): Promise<void> {
  const homeDir = mkdtempSync(join(tmpdir(), "wct-tui-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    await run();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

async function withConfigFixture(
  content: string,
  run: (repoPath: string) => Promise<void>,
): Promise<void> {
  const repoPath = mkdtempSync(join(tmpdir(), "wct-tui-registry-"));
  writeFileSync(join(repoPath, ".wct.yaml"), content);
  await withIsolatedHome(() => run(repoPath));
}
```

Add imports:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 2: Let hooks verify the tests fail**

Do not run tests manually. Expected hook result before implementation: `getIdeDefaults` does not exist.

- [ ] **Step 3: Implement derived TUI IDE defaults**

In `src/tui/hooks/useRegistry.ts`, import config helpers:

```ts
import {
  loadConfig,
  resolveIdeLaunch,
  resolveProfile,
} from "../../config/loader";
```

Add interfaces:

```ts
export interface IdeDefaults {
  baseNoIde: boolean;
  profileNoIde: Record<string, boolean>;
}
```

Add to `RepoInfo`:

```ts
ideDefaults: IdeDefaults;
```

Add the async dependency shape:

```ts
interface LoadRepoInfoDeps {
  pathExists: (path: string) => boolean;
  getProfileNames: (repoPath: string) => string[];
  getIdeDefaults: (repoPath: string) => Promise<IdeDefaults>;
  // existing deps...
}
```

Add the helper:

```ts
export async function getIdeDefaults(repoPath: string): Promise<IdeDefaults> {
  try {
    const { config } = await loadConfig(repoPath);
    if (!config) {
      return { baseNoIde: true, profileNoIde: {} };
    }
    const baseNoIde = !resolveIdeLaunch(config.ide, {}).open;
    const profileNoIde: Record<string, boolean> = {};
    for (const name of Object.keys(config.profiles ?? {})) {
      const { config: profiled } = resolveProfile(config, "main", name);
      profileNoIde[name] = !resolveIdeLaunch(profiled.ide, {}).open;
    }
    return { baseNoIde, profileNoIde };
  } catch {
    return { baseNoIde: true, profileNoIde: {} };
  }
}
```

Update `loadRepoInfo` to call the async dependency before returning:

```ts
const [profileNames, ideDefaults] = await Promise.all([
  Promise.resolve(deps.getProfileNames(item.repo_path)),
  deps.getIdeDefaults(item.repo_path),
]);
```

Include `ideDefaults` in every `RepoInfo` return, including error paths:

```ts
ideDefaults,
```

For missing directory paths, use:

```ts
const ideDefaults = { baseNoIde: true, profileNoIde: {} };
```

- [ ] **Step 4: Update tests for async helper**

The tests from Step 1 should use async expectations:

```ts
await expect(getIdeDefaults(repoPath)).resolves.toEqual({
  baseNoIde: false,
  profileNoIde: {},
});
```

- [ ] **Step 5: Let hooks verify Task 6**

Do not run tests manually. Expected final hook result for this task: TUI registry tests pass and no invalid config blocks modal defaults.

- [ ] **Step 6: Commit Task 6**

```bash
git add -A
git commit -m "feat: load tui ide defaults"
```

---

### Task 7: Apply Profile-Sensitive “No IDE” Defaults In Modals

**Files:**
- Modify: `src/tui/hooks/useSessionOptionsState.ts`
- Modify: `src/tui/components/SessionOptionsSection.tsx`
- Modify: `src/tui/components/UpModal.tsx`
- Modify: `src/tui/components/OpenModal.tsx`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/types.ts`
- Modify: `src/tui/hooks/useModalActions.ts`
- Test: `tests/tui/session-options.test.ts`
- Test: `tests/tui/up-modal.test.tsx`
- Test: `tests/tui/open-modal.test.tsx`
- Test: `tests/tui/modal-actions.test.ts`

- [ ] **Step 1: Write failing session-state tests**

In `tests/tui/session-options.test.ts`, add pure helper tests after creating the helper in implementation:

```ts
import { resolveNoIdeDefault } from "../../src/tui/hooks/useSessionOptionsState";

describe("resolveNoIdeDefault", () => {
  test("uses base default when no named profile is selected", () => {
    expect(
      resolveNoIdeDefault({
        selectedProfileValue: "",
        baseNoIde: true,
        profileNoIde: { dev: false },
      }),
    ).toBe(true);
  });

  test("uses named profile default when selected", () => {
    expect(
      resolveNoIdeDefault({
        selectedProfileValue: "dev",
        baseNoIde: true,
        profileNoIde: { dev: false },
      }),
    ).toBe(false);
  });

  test("falls back to base default for unknown selected profile", () => {
    expect(
      resolveNoIdeDefault({
        selectedProfileValue: "missing",
        baseNoIde: false,
        profileNoIde: {},
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Implement session-state helper**

In `src/tui/hooks/useSessionOptionsState.ts`, add:

```ts
export interface SessionIdeDefaults {
  baseNoIde: boolean;
  profileNoIde: Record<string, boolean>;
}

const DEFAULT_SESSION_IDE_DEFAULTS: SessionIdeDefaults = {
  baseNoIde: false,
  profileNoIde: {},
};

export function resolveNoIdeDefault(opts: {
  selectedProfileValue: string | undefined;
  baseNoIde: boolean;
  profileNoIde: Record<string, boolean>;
}): boolean {
  if (opts.selectedProfileValue && opts.selectedProfileValue in opts.profileNoIde) {
    return opts.profileNoIde[opts.selectedProfileValue] ?? opts.baseNoIde;
  }
  return opts.baseNoIde;
}
```

Update `useSessionOptionsState` signature:

```ts
export function useSessionOptionsState(
  profileNames: string[],
  enabled = true,
  ideDefaults: SessionIdeDefaults = DEFAULT_SESSION_IDE_DEFAULTS,
): SessionOptionsState {
```

Initialize `noIde` from the initial profile:

```ts
const initialProfile = getInitialSelectedProfileValue(profileNames);
const [selectedProfileValue, setSelectedProfileValue] = useState<
  string | undefined
>(() => initialProfile);
const [noIde, setNoIde] = useState(() =>
  resolveNoIdeDefault({
    selectedProfileValue: initialProfile,
    baseNoIde: ideDefaults.baseNoIde,
    profileNoIde: ideDefaults.profileNoIde,
  }),
);
```

On reset, apply defaults:

```ts
const ideDefaultsKey = JSON.stringify(ideDefaults);
// biome-ignore lint/correctness/useExhaustiveDependencies: ideDefaultsKey is a content-derived stable identity for ideDefaults
useEffect(() => {
  if (!enabled) return;
  const nextProfile = getInitialSelectedProfileValue(profileNames);
  setSelectedProfileValue(nextProfile);
  setNoIde(
    resolveNoIdeDefault({
      selectedProfileValue: nextProfile,
      baseNoIde: ideDefaults.baseNoIde,
      profileNoIde: ideDefaults.profileNoIde,
    }),
  );
  setAutoSwitch(true);
}, [profileKey, enabled, ideDefaultsKey]);
```

Add an effect to update `noIde` when the selected profile or the content of the defaults changes. Do not depend on the `profileNoIde` object identity; that can reset a user's manual toggle when a parent passes an equivalent fresh object.

```ts
// biome-ignore lint/correctness/useExhaustiveDependencies: ideDefaultsKey is a content-derived stable identity for ideDefaults
useEffect(() => {
  if (!enabled) return;
  setNoIde(
    resolveNoIdeDefault({
      selectedProfileValue,
      baseNoIde: ideDefaults.baseNoIde,
      profileNoIde: ideDefaults.profileNoIde,
    }),
  );
}, [selectedProfileValue, enabled, ideDefaultsKey]);
```

- [ ] **Step 3: Pass defaults into UpModal and OpenModal**

In `src/tui/components/UpModal.tsx`, add prop:

```ts
ideDefaults?: SessionIdeDefaults;
```

Pass it to `useSessionOptionsState`:

```ts
const {
  selectedProfileValue,
  setSelectedProfileValue,
  noIde,
  setNoIde,
  autoSwitch,
  setAutoSwitch,
} = useSessionOptionsState(profileNames, visible, ideDefaults);
```

In `src/tui/components/OpenModal.tsx`, add prop:

```ts
ideDefaults: SessionIdeDefaults;
```

Pass `ideDefaults` into `NewBranchForm`, `FromPRForm`, and `ExistingBranchForm`, add the prop to each form, and call:

```ts
useSessionOptionsState(profileNames, true, ideDefaults);
```

- [ ] **Step 4: Pass defaults from app state**

In `src/tui/types.ts`, extend `Mode.UpModal`:

```ts
ideDefaults: import("./hooks/useSessionOptionsState").SessionIdeDefaults;
```

Update the constructor:

```ts
UpModal: (
  worktreePath: string,
  worktreeKey: string,
  profileNames: string[],
  ideDefaults: import("./hooks/useSessionOptionsState").SessionIdeDefaults,
): Mode => ({
  type: "UpModal",
  worktreePath,
  worktreeKey,
  profileNames,
  ideDefaults,
}),
```

In `src/tui/hooks/useModalActions.ts`, add state setter:

```ts
setOpenModalIdeDefaults: (v: SessionIdeDefaults) => void;
```

In `createPrepareOpenModal`, set:

```ts
let ideDefaults: SessionIdeDefaults = { baseNoIde: true, profileNoIde: {} };
// when repo exists:
ideDefaults = repo.ideDefaults;
deps.setOpenModalIdeDefaults(ideDefaults);
```

In `src/tui/hooks/useModalActions.ts`, update the existing `Mode.UpModal` call from:

```ts
deps.setMode(Mode.UpModal(wt.path, worktreeKey, repo.profileNames));
```

to:

```ts
deps.setMode(
  Mode.UpModal(wt.path, worktreeKey, repo.profileNames, repo.ideDefaults),
);
```

In `src/tui/App.tsx`, add state:

```ts
const [openModalIdeDefaults, setOpenModalIdeDefaults] =
  useState<SessionIdeDefaults>({ baseNoIde: true, profileNoIde: {} });
```

Pass setter into modal deps and prop into `OpenModal`:

```tsx
ideDefaults={openModalIdeDefaults}
```

Pass into `UpModal`:

```tsx
ideDefaults={mode.ideDefaults}
```

- [ ] **Step 5: Convert unchecked “No IDE” into force-IDE behavior**

In `src/tui/hooks/useModalActions.ts`, when calling `resolveOpenOptions`, pass:

```ts
ide: !opts.noIde,
noIde: opts.noIde,
```

When calling `startWorktreeSession`, pass:

```ts
ide: !result.noIde,
noIde: result.noIde,
```

This is intentionally stronger than the CLI default: modal submit always reflects the checkbox state. If “No IDE” is checked, skip. If unchecked, force IDE open, using configured command or fallback.

- [ ] **Step 6: Let hooks verify Task 7**

Do not run tests manually. Expected final hook result for this task: modal tests pass with config/profile-sensitive `No IDE` defaults.

- [ ] **Step 7: Commit Task 7**

```bash
git add -A
git commit -m "feat: default tui no ide from config"
```

---

### Task 8: Update Help Text, Init Template, And Completions Expectations

**Files:**
- Modify: `src/commands/init.ts`
- Modify: `src/commands/open.ts`
- Modify: `src/commands/up.ts`
- Modify: `src/cli/root-command.ts`
- Test: `tests/completions.test.ts`

- [ ] **Step 1: Update init template**

In `src/commands/init.ts`, change the IDE template:

```yaml
# IDE command (environment variables available: WCT_WORKTREE_DIR, WCT_MAIN_DIR, WCT_BRANCH, WCT_PROJECT)
ide:
  open: true
  name: vscode
  command: "code $WCT_WORKTREE_DIR"
  # command: "cursor $WCT_WORKTREE_DIR"
  # fork_workspace: true  # (vscode only) copy VS Code workspace state to worktree; requires main repo opened in VS Code once
```

- [ ] **Step 2: Update command descriptions**

In `src/commands/open.ts`:

```ts
description: "Create worktree, run setup, and start configured environment",
```

In `src/commands/up.ts`:

```ts
description: "Start configured environment for a worktree",
```

In `src/cli/root-command.ts`, update the `Command.withDescription` calls:

```ts
Command.withDescription("Start configured environment for a worktree")
```

```ts
Command.withDescription(
  "Create worktree, run setup, and start configured environment",
)
```

- [ ] **Step 3: Update completions test expectations**

In `tests/completions.test.ts`, update hardcoded expected flags for `open` from:

```ts
"COMPREPLY=($(compgen -W '--help --version --completions --log-level --base -b --existing -e --no-ide --no-attach --pr --prompt -p --profile -P' -- \"$cur\"))"
```

to:

```ts
"COMPREPLY=($(compgen -W '--help --version --completions --log-level --base -b --existing -e --ide --no-ide --no-attach --pr --prompt -p --profile -P' -- \"$cur\"))"
```

Also update any `up` completion expectations to include `--ide` before `--no-ide`.

- [ ] **Step 4: Let hooks verify Task 8**

Do not run tests manually. Expected final hook result for this task: completions and command metadata tests pass.

- [ ] **Step 5: Commit Task 8**

```bash
git add -A
git commit -m "docs: update ide option help"
```

---

### Task 9: Final Consistency Pass

**Files:**
- Review: `src/config/loader.ts`
- Review: `src/commands/open.ts`
- Review: `src/commands/worktree-session.ts`
- Review: `src/tui/hooks/useRegistry.ts`
- Review: `src/tui/hooks/useModalActions.ts`
- Review: `tests/*`

- [ ] **Step 1: Search for old assumptions**

Run only search commands, not tests:

```bash
rg -n "DEFAULT_CONFIG\\.ide|ide\\?\\.command && !noIde|open IDE for a worktree|start tmux session and open IDE|ide: false|--no-ide --no-attach" src tests docs
```

Expected: no stale source assumptions remain. Historical docs under old plans may still mention old behavior; do not edit unrelated historical plan files.

- [ ] **Step 2: Verify no manual test command was run**

Check shell history mentally for this session. Do not run `bun run test` or `bun run lint`. The Stop hook is the authority for final verification.

- [ ] **Step 3: Let hooks perform final verification**

End the implementation session normally. Expected Stop hook result: `biome lint --write` succeeds and `bun run test` passes.

- [ ] **Step 4: Commit final cleanup if hooks changed files**

If hooks formatted or lint-fixed files, commit those exact changes:

```bash
git add -A
git commit -m "chore: format ide defaults changes"
```

---

## Self-Review

**Spec coverage:**
- No config means no IDE by default: Task 1 removes IDE from `DEFAULT_CONFIG`; Task 3 launch helper skips missing config.
- Global config counts: Task 2 preserves global/project merge behavior and makes IDE object merge field-wise.
- CLI options override files: Tasks 4 and 5 add `--ide`, preserve `--no-ide`, and fail on both flags.
- Fallback command: Task 3 uses `DEFAULT_IDE_CONFIG` only when force-opening without a command.
- `ide.open` shape: Tasks 1 and 2 add `open?: boolean` and merge it consistently across global, project, and profile.
- TUI “No IDE” checkbox reflects config and profiles: Tasks 6 and 7 derive and apply base/profile defaults.
- Workspace sync only when final decision opens IDE: Task 4 gates sync behind `ideLaunch.open`.
- Init/help/completions: Task 8 updates template, descriptions, and expected shell flags.

**Placeholder scan:** No task uses “TBD,” “TODO,” “implement later,” or unspecified error handling as the implementation instruction.

**Type consistency:** The plan consistently uses `ide?: boolean`, `noIde?: boolean`, `ide.open`, `DEFAULT_IDE_CONFIG`, `resolveIdeLaunch`, `SessionIdeDefaults`, and `IdeDefaults`.

# Config Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named config profiles to `.wct.yaml` that override base config sections per worktree, selected via `--profile` flag or auto-matched by branch name glob.

**Architecture:** New `ProfileSchema` in the config schema, a `resolveProfile()` function in the loader that applies profile overrides to the base config, `--profile` flag on `open` and `up` commands, and shell completions for profile names.

**Tech Stack:** Effect v4, Bun (Bun.Glob for matching), vitest for tests

**Spec:** `docs/superpowers/specs/2026-03-20-config-profiles-design.md`

---

## File Map

- Modify: `src/config/schema.ts` — Add `ProfileSchema`, add `profiles` field to `WctConfigSchema` and `ResolvedConfigSchema`
- Modify: `src/config/loader.ts` — Add `resolveProfile()` function, update `mergeConfigs` for profiles key
- Modify: `src/config/validator.ts` — Validate tmux window names inside profile sections
- Modify: `src/commands/command-def.ts` — Add `completionValues` to `CommandOption` for dynamic completions
- Modify: `src/commands/open.ts` — Add `profile` option, call `resolveProfile` after loading config
- Modify: `src/commands/up.ts` — Add `profile` option, call `resolveProfile` after loading config
- Modify: `src/cli/root-command.ts` — Wire `--profile` flag for `open` and `up` CLI commands
- Modify: `src/cli/completions.ts` — Add `__wct_profiles` helper and wire profile name completions for `--profile` option
- Create: `tests/profile.test.ts` — Unit tests for profile resolution and validation

---

### Task 1: Add ProfileSchema to config schema

**Files:**
- Modify: `src/config/schema.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```ts
test("accepts valid config with profiles", () => {
  const result = validateConfig({
    version: 1,
    setup: [{ name: "Install", command: "bun install" }],
    ide: { command: "code ." },
    tmux: { windows: [{ name: "main" }] },
    profiles: {
      frontend: {
        match: "feature/frontend-*",
        ide: { command: "cursor ." },
        tmux: { windows: [{ name: "dev", command: "bun run dev" }] },
      },
      docs: {
        match: ["docs/*", "content/*"],
        setup: [{ name: "Build", command: "bun run build" }],
      },
      minimal: {
        tmux: { windows: [{ name: "shell" }] },
      },
    },
  });
  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test("rejects profile with invalid tmux config", () => {
  const result = validateConfig({
    profiles: {
      bad: {
        tmux: { windows: "not-an-array" },
      },
    },
  });
  expect(result.valid).toBe(false);
});

test("rejects profile with invalid match type", () => {
  const result = validateConfig({
    profiles: {
      bad: {
        match: 123,
      },
    },
  });
  expect(result.valid).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/config.test.ts`
Expected: FAIL — profiles key not recognized by schema

- [ ] **Step 3: Add ProfileSchema and update WctConfigSchema**

In `src/config/schema.ts`, add after `IdeConfigSchema`:

```ts
export const ProfileSchema = Schema.Struct({
  match: Schema.optional(
    Schema.Union(Schema.String, Schema.Array(Schema.String)),
  ),
  copy: Schema.optional(Schema.Array(Schema.String)),
  setup: Schema.optional(Schema.Array(SetupCommandSchema)),
  ide: Schema.optional(IdeConfigSchema),
  tmux: Schema.optional(TmuxConfigSchema),
});
```

Add to `WctConfigSchema`:

```ts
profiles: Schema.optional(
  Schema.Record({ key: Schema.String, value: ProfileSchema }),
),
```

Add the same `profiles` field to `ResolvedConfigSchema`.

Add exports:

```ts
export type Profile = typeof ProfileSchema.Type;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Run linter**

Run: `bunx biome check --write src/config/schema.ts tests/config.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts tests/config.test.ts
git commit -m "feat: add ProfileSchema to config schema"
```

---

### Task 2: Update mergeConfigs and add resolveProfile

**Files:**
- Modify: `src/config/loader.ts`
- Create: `tests/profile.test.ts`

`resolveProfile` returns a `ProfileResult` object with both the resolved config and the name of the matched profile (if any). This allows callers to log which profile was selected for both explicit and auto-matched cases.

- [ ] **Step 1: Write the failing tests**

Create `tests/profile.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { resolveProfile } from "../src/config/loader";
import type { ResolvedConfig } from "../src/config/schema";

function baseConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    worktree_dir: "../worktrees",
    project_name: "test",
    setup: [{ name: "Install", command: "bun install" }],
    ide: { command: "code ." },
    tmux: { windows: [{ name: "main" }] },
    copy: [".env"],
    ...overrides,
  };
}

describe("resolveProfile", () => {
  test("returns base config when no profiles defined", () => {
    const config = baseConfig();
    const { config: result } = resolveProfile(config, "feature/auth");
    expect(result.tmux).toEqual(config.tmux);
    expect(result.ide).toEqual(config.ide);
  });

  test("returns no profileName when no profiles defined", () => {
    const config = baseConfig();
    const { profileName } = resolveProfile(config, "feature/auth");
    expect(profileName).toBeUndefined();
  });

  test("returns base config when no profile matches", () => {
    const config = baseConfig({
      profiles: {
        frontend: {
          match: "feature/frontend-*",
          tmux: { windows: [{ name: "dev" }] },
        },
      },
    });
    const { config: result } = resolveProfile(config, "feature/backend-auth");
    expect(result.tmux).toEqual(config.tmux);
  });

  test("auto-matches profile by branch glob", () => {
    const config = baseConfig({
      profiles: {
        frontend: {
          match: "feature/frontend-*",
          tmux: { windows: [{ name: "dev" }] },
        },
      },
    });
    const { config: result, profileName } = resolveProfile(config, "feature/frontend-auth");
    expect(result.tmux).toEqual({ windows: [{ name: "dev" }] });
    expect(profileName).toBe("frontend");
  });

  test("auto-matches with array of globs", () => {
    const config = baseConfig({
      profiles: {
        docs: {
          match: ["docs/*", "content/*"],
          tmux: { windows: [{ name: "edit" }] },
        },
      },
    });
    const { config: result, profileName } = resolveProfile(config, "content/new-page");
    expect(result.tmux).toEqual({ windows: [{ name: "edit" }] });
    expect(profileName).toBe("docs");
  });

  test("first match wins when multiple profiles match", () => {
    const config = baseConfig({
      profiles: {
        specific: {
          match: "feature/frontend-auth",
          ide: { command: "cursor ." },
        },
        broad: {
          match: "feature/*",
          ide: { command: "vim ." },
        },
      },
    });
    const { config: result, profileName } = resolveProfile(config, "feature/frontend-auth");
    expect(result.ide).toEqual({ command: "cursor ." });
    expect(profileName).toBe("specific");
  });

  test("explicit profile selection by name", () => {
    const config = baseConfig({
      profiles: {
        minimal: {
          tmux: { windows: [{ name: "shell" }] },
        },
      },
    });
    const { config: result, profileName } = resolveProfile(config, "any-branch", "minimal");
    expect(result.tmux).toEqual({ windows: [{ name: "shell" }] });
    expect(profileName).toBe("minimal");
  });

  test("explicit profile errors on unknown name", () => {
    const config = baseConfig({
      profiles: {
        minimal: {
          tmux: { windows: [{ name: "shell" }] },
        },
      },
    });
    expect(() => resolveProfile(config, "any-branch", "nonexistent")).toThrow(
      /nonexistent/,
    );
  });

  test("profile replaces only sections it defines", () => {
    const config = baseConfig({
      profiles: {
        frontend: {
          match: "feature/frontend-*",
          tmux: { windows: [{ name: "dev" }] },
        },
      },
    });
    const { config: result } = resolveProfile(config, "feature/frontend-auth");
    expect(result.tmux).toEqual({ windows: [{ name: "dev" }] });
    expect(result.ide).toEqual({ command: "code ." });
    expect(result.setup).toEqual([{ name: "Install", command: "bun install" }]);
    expect(result.copy).toEqual([".env"]);
  });

  test("profile can replace all four sections", () => {
    const config = baseConfig({
      profiles: {
        full: {
          match: "full/*",
          setup: [{ name: "Build", command: "make" }],
          ide: { command: "vim ." },
          tmux: { windows: [{ name: "editor" }] },
          copy: [".gitignore"],
        },
      },
    });
    const { config: result } = resolveProfile(config, "full/test");
    expect(result.setup).toEqual([{ name: "Build", command: "make" }]);
    expect(result.ide).toEqual({ command: "vim ." });
    expect(result.tmux).toEqual({ windows: [{ name: "editor" }] });
    expect(result.copy).toEqual([".gitignore"]);
  });

  test("empty string profile treated as no profile", () => {
    const config = baseConfig({
      profiles: {
        minimal: {
          tmux: { windows: [{ name: "shell" }] },
        },
      },
    });
    const { config: result } = resolveProfile(config, "main", "");
    expect(result.tmux).toEqual(config.tmux);
  });

  test("profile without match is skipped during auto-matching", () => {
    const config = baseConfig({
      profiles: {
        manual: {
          tmux: { windows: [{ name: "manual" }] },
        },
      },
    });
    const { config: result } = resolveProfile(config, "any-branch");
    expect(result.tmux).toEqual(config.tmux);
  });

  test("strips profiles key from returned config", () => {
    const config = baseConfig({
      profiles: {
        minimal: {
          match: "main",
          tmux: { windows: [{ name: "shell" }] },
        },
      },
    });
    const { config: result } = resolveProfile(config, "main");
    expect(result.profiles).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/profile.test.ts`
Expected: FAIL — `resolveProfile` not exported from loader

- [ ] **Step 3: Implement resolveProfile in loader.ts**

In `src/config/loader.ts`, add import for `Profile`:

```ts
import type { Profile, ResolvedConfig, WctConfig } from "./schema";
```

Add the `ProfileResult` interface and implementation before the `export { CONFIG_FILENAME, DEFAULT_CONFIG }` line:

```ts
export interface ProfileResult {
  config: ResolvedConfig;
  profileName?: string;
}

function matchesGlob(branch: string, pattern: string): boolean {
  const glob = new Bun.Glob(pattern);
  return glob.match(branch);
}

function profileMatchesBranch(
  profile: Profile,
  branch: string,
): boolean {
  if (!profile.match) return false;
  const patterns = Array.isArray(profile.match)
    ? profile.match
    : [profile.match];
  return patterns.some((pattern) => matchesGlob(branch, pattern));
}

function applyProfile(
  config: ResolvedConfig,
  profile: Profile,
): ResolvedConfig {
  const { profiles: _, ...base } = config;
  return {
    ...base,
    setup: profile.setup ?? base.setup,
    ide: profile.ide ?? base.ide,
    tmux: profile.tmux ?? base.tmux,
    copy: profile.copy ?? base.copy,
  };
}

function stripProfiles(config: ResolvedConfig): ResolvedConfig {
  const { profiles: _, ...rest } = config;
  return rest;
}

export function resolveProfile(
  config: ResolvedConfig,
  branch: string,
  explicitProfile?: string,
): ProfileResult {
  if (explicitProfile === "") {
    return { config: stripProfiles(config) };
  }

  if (!config.profiles) {
    return { config: stripProfiles(config) };
  }

  if (explicitProfile) {
    const profile = config.profiles[explicitProfile];
    if (!profile) {
      throw new Error(
        `Profile '${explicitProfile}' not found. Available profiles: ${Object.keys(config.profiles).join(", ")}`,
      );
    }
    return {
      config: applyProfile(config, profile),
      profileName: explicitProfile,
    };
  }

  for (const [name, profile] of Object.entries(config.profiles)) {
    if (profileMatchesBranch(profile, branch)) {
      return { config: applyProfile(config, profile), profileName: name };
    }
  }

  return { config: stripProfiles(config) };
}
```

Also update `mergeConfigs` to explicitly handle the `profiles` key — add this line in the merge return object alongside the other explicit keys:

```ts
profiles: project.profiles ?? global.profiles,
```

Note: the spread `...global, ...project` would already handle this, but being explicit is consistent with how `copy`, `setup`, `ide`, and `tmux` are handled.

Note: `resolveConfig` in `validator.ts` needs no change — its spread `...config` already passes `profiles` through to `ResolvedConfig`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/profile.test.ts`
Expected: PASS

- [ ] **Step 5: Run linter**

Run: `bunx biome check --write src/config/loader.ts tests/profile.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/config/loader.ts tests/profile.test.ts
git commit -m "feat: add resolveProfile function for config profiles"
```

---

### Task 3: Validate tmux window names in profile sections

**Files:**
- Modify: `src/config/validator.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```ts
test("rejects profile tmux window name with invalid characters", () => {
  const result = validateConfig({
    profiles: {
      bad: {
        tmux: {
          windows: [{ name: "dev:server" }],
        },
      },
    },
  });
  expect(result.valid).toBe(false);
  expect(
    result.errors.some((e) => e.includes("profiles.bad.tmux.windows[0].name")),
  ).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts -t "rejects profile tmux"`
Expected: FAIL — validation doesn't check profile tmux windows

- [ ] **Step 3: Update validateConfig to check profile tmux windows**

In `src/config/validator.ts`, import `WctConfigSchema` is already there. After the existing `validateTmuxWindowNames` call, add profile validation:

```ts
const decoded = Schema.decodeUnknownSync(WctConfigSchema)(config);
if (decoded.tmux?.windows) {
  errors.push(...validateTmuxWindowNames(decoded));
}

if (decoded.profiles) {
  for (const [profileName, profile] of Object.entries(decoded.profiles)) {
    if (profile.tmux?.windows) {
      const profileErrors = validateTmuxWindowNames({
        tmux: profile.tmux,
      } as WctConfig);
      errors.push(
        ...profileErrors.map((e) =>
          e.replace("tmux.", `profiles.${profileName}.tmux.`),
        ),
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Run linter**

Run: `bunx biome check --write src/config/validator.ts tests/config.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/config/validator.ts tests/config.test.ts
git commit -m "feat: validate tmux window names in profile sections"
```

---

### Task 4: Add --profile flag to open command

**Files:**
- Modify: `src/commands/open.ts`
- Modify: `src/commands/command-def.ts` (add `commandDef` option)
- Modify: `src/cli/root-command.ts`

- [ ] **Step 1: Add --profile to open commandDef options**

In `src/commands/open.ts`, add to the `options` array in `commandDef`:

```ts
{
  name: "profile",
  short: "P",
  type: "string",
  placeholder: "name",
  description: "Use a named config profile",
},
```

- [ ] **Step 2: Update OpenOptions and openCommand to accept profile**

In `src/commands/open.ts`, add `profile` to `OpenOptions`:

```ts
export interface OpenOptions {
  branch: string;
  existing: boolean;
  base?: string;
  noIde?: boolean;
  noAttach?: boolean;
  prompt?: string;
  profile?: string;
}
```

Add import for `resolveProfile`:

```ts
import { loadConfig, resolveProfile, resolveWorktreePath } from "../config/loader";
```

In `openCommand`, after loading config and before using it, add profile resolution and logging:

```ts
const { config: resolved, profileName } = resolveProfile(config, branch, profile);
if (profileName) {
  yield* logger.info(`Using profile '${profileName}'`);
}
```

Then replace all subsequent uses of `config` with `resolved` for the profile-overridable sections:
- `resolved.ide` instead of `config.ide` (includes the `ide?.name` and `ide?.fork_workspace` checks for VS Code workspace logic)
- `resolved.copy` instead of `config.copy`
- `resolved.setup` instead of `config.setup`
- `resolved.tmux` instead of `config.tmux`
- Keep `config.worktree_dir` and `config.project_name` (these come from base, not profiles)

- [ ] **Step 3: Wire --profile in root-command.ts for open**

In `src/cli/root-command.ts`, update `openCliCommand`:

Add a `profile` flag:

```ts
profile: optionalStringFlag(
  "profile",
  "Use a named config profile",
  "P",
  "NAME",
),
```

Pass it through to `openCommand`:

```ts
return yield* openCommand({
  branch: branchArg,
  existing,
  base: baseValue,
  noIde,
  noAttach,
  prompt: promptValue,
  profile: optionToUndefined(profile),
});
```

Also pass it in the PR path:

```ts
return yield* openCommand({
  branch: resolvedBranch,
  existing: localExists,
  base: localExists ? undefined : `${remote}/${resolvedBranch}`,
  noIde,
  noAttach,
  prompt: promptValue,
  profile: optionToUndefined(profile),
});
```

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Run linter**

Run: `bunx biome check --write src/commands/open.ts src/cli/root-command.ts`

- [ ] **Step 6: Commit**

```bash
git add src/commands/open.ts src/cli/root-command.ts
git commit -m "feat: add --profile flag to open command"
```

---

### Task 5: Add --profile flag to up command

**Files:**
- Modify: `src/commands/up.ts`
- Modify: `src/cli/root-command.ts`

- [ ] **Step 1: Add --profile to up commandDef options**

In `src/commands/up.ts`, add to the `options` array:

```ts
{
  name: "profile",
  short: "P",
  type: "string",
  placeholder: "name",
  description: "Use a named config profile",
},
```

- [ ] **Step 2: Update UpOptions and upCommand**

Add `profile` to `UpOptions`:

```ts
export interface UpOptions {
  noIde?: boolean;
  noAttach?: boolean;
  profile?: string;
}
```

Import `resolveProfile`:

```ts
import { loadConfig, resolveProfile } from "../config/loader";
```

After loading config and getting the branch, add:

```ts
const { config: resolved, profileName } = resolveProfile(config, branch, profile);
if (profileName) {
  yield* logger.info(`Using profile '${profileName}'`);
}
```

Update `launchSessionAndIde` call to use `resolved.tmux` and `resolved.ide?.command` instead of `config.tmux` and `config.ide?.command`.

- [ ] **Step 3: Wire --profile in root-command.ts for up**

In `src/cli/root-command.ts`, update `upCliCommand`:

```ts
const upCliCommand = Command.make(
  "up",
  {
    noIde: booleanFlag("no-ide", "Skip opening IDE"),
    noAttach: booleanFlag("no-attach", "Do not attach to tmux outside tmux"),
    profile: optionalStringFlag("profile", "Use a named config profile", "P", "NAME"),
  },
  ({ noIde, noAttach, profile }) =>
    upCommand({ noIde, noAttach, profile: optionToUndefined(profile) }),
).pipe(
  Command.withDescription(
    "Start tmux session and open IDE in current directory",
  ),
);
```

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Run linter**

Run: `bunx biome check --write src/commands/up.ts src/cli/root-command.ts`

- [ ] **Step 6: Commit**

```bash
git add src/commands/up.ts src/cli/root-command.ts
git commit -m "feat: add --profile flag to up command"
```

---

### Task 6: Add shell completions for --profile

**Files:**
- Modify: `src/commands/command-def.ts`
- Modify: `src/commands/open.ts`
- Modify: `src/commands/up.ts`
- Modify: `src/cli/completions.ts`

The completions system generates static shell scripts. Profile names come from the config file and can't be known at script-generation time. The approach: add `__wct_profiles` shell helper functions (one per shell) that parse `.wct.yaml` at completion time, and a generic `completionValues` field on `CommandOption` to wire them up.

The shell helpers use `awk` to extract only keys under the `profiles:` top-level section (stops at the next unindented line), avoiding false positives from other 2-space-indented keys like tmux window names.

- [ ] **Step 1: Update CommandOption in command-def.ts**

In `src/commands/command-def.ts`, add to `CommandOption`:

```ts
completionValues?: string;
```

- [ ] **Step 2: Add completionValues to --profile options in open.ts and up.ts**

In both `src/commands/open.ts` and `src/commands/up.ts`, add to the `--profile` option object:

```ts
completionValues: "__wct_profiles",
```

- [ ] **Step 3: Add __wct_profiles helpers and wire completionValues in all three shell generators**

In `generateFishCompletions()`, after `__wct_worktree_branches`, add:

```ts
"# Helper: list config profile names",
"function __wct_profiles",
"    if test -f .wct.yaml",
"        awk '/^profiles:/{found=1;next} found && /^[^ ]/{exit} found && /^  [a-zA-Z]/{sub(/^  /,\"\");sub(/:.*/,\"\");print}' .wct.yaml",
"    end",
"end",
"",
```

In the per-command options loop, when `option.completionValues` is set, append to the completion line:

```ts
if (option.completionValues) {
  parts.push(`-a '(${option.completionValues})'`);
}
```

In `generateBashCompletions()`, after `_wct_worktree_branches`, add:

```ts
"_wct_profiles() {",
"    if [[ -f .wct.yaml ]]; then",
"        awk '/^profiles:/{found=1;next} found && /^[^ ]/{exit} found && /^  [a-zA-Z]/{sub(/^  /,\"\");sub(/:.*/,\"\");print}' .wct.yaml",
"    fi",
"}",
"",
```

Add a `prev` word check at the top of `_wct()`, after the `cur` line:

```ts
'    local prev="${COMP_WORDS[COMP_CWORD-1]}"',
```

Then, for each command's options, generate a `prev` check block for string options with `completionValues`. Use a generic approach: iterate options, and for each with `completionValues`, add:

```ts
`    if [[ "$prev" == "--${option.name}"${option.short ? ` || "$prev" == "-${option.short}"` : ""} ]]; then`,
`        COMPREPLY=($(compgen -W "$(${option.completionValues})" -- "$cur"))`,
`        return`,
`    fi`,
```

Place this block right after the `cword -eq 1` early return.

In `generateZshCompletions()`, after `_wct_worktree_branches`, add:

```ts
"_wct_profiles() {",
"    local profiles",
"    if [[ -f .wct.yaml ]]; then",
"        profiles=($(awk '/^profiles:/{found=1;next} found && /^[^ ]/{exit} found && /^  [a-zA-Z]/{sub(/^  /,\"\");sub(/:.*/,\"\");print}' .wct.yaml))",
"        _describe 'profile' profiles",
"    fi",
"}",
"",
```

For zsh per-command options, when `option.completionValues` is set, append the function as the completion action in the argument spec. The key difference is adding `_wct_profiles` as the completion function:

For string options with `option.short` and `option.completionValues`:
```
'(-P --profile)'{-P,--profile}'[Use a named config profile]:name:_wct_profiles'
```

For string options without `option.short` and with `option.completionValues`:
```
'--profile[Use a named config profile]:name:_wct_profiles'
```

- [ ] **Step 4: Run tests and linter**

Run: `bun test tests/completions.test.ts && bunx biome check --write src/cli/completions.ts src/commands/command-def.ts src/commands/open.ts src/commands/up.ts`
Expected: PASS

- [ ] **Step 5: Manually verify completions output**

Run: `bun run src/index.ts --completions fish | grep -A5 __wct_profiles`
Run: `bun run src/index.ts --completions bash | grep -A5 _wct_profiles`
Run: `bun run src/index.ts --completions zsh | grep -A5 _wct_profiles`

Verify:
1. The `__wct_profiles` / `_wct_profiles` helper functions use `awk` scoped to the `profiles:` section
2. The `--profile` option completions reference the helper function

- [ ] **Step 6: Commit**

```bash
git add src/cli/completions.ts src/commands/command-def.ts src/commands/open.ts src/commands/up.ts
git commit -m "feat: add shell completions for --profile option"
```

---

### Task 7: Final integration test and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 2: Run linter on all modified files**

Run: `bunx biome check --write src/ tests/`
Expected: No errors

- [ ] **Step 3: Manual smoke test**

Create a test `.wct.yaml` with profiles and verify:

```bash
# Verify config loads with profiles
bun run src/index.ts open --help
# Should show --profile / -P option
```

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "chore: final cleanup for config profiles feature"
```

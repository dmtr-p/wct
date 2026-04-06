# Projects Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace top-level `register`/`unregister` commands with `wct projects add/remove/list` subcommands.

**Architecture:** Single new `src/commands/projects.ts` file exports three command functions. `root-command.ts` wires them as subcommands under a `projects` parent. Completions and command-def are updated to support nested subcommands. Old files deleted.

**Tech Stack:** Effect v4, RegistryService (existing), JsonFlag for JSON output

---

### Task 1: Create `src/commands/projects.ts`

**Files:**
- Create: `src/commands/projects.ts`

- [ ] **Step 1: Write the `projectsAddCommand` function**

```typescript
import { resolve } from "node:path";
import { Console, Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";
import { loadConfig } from "../config/loader";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { RegistryService } from "../services/registry-service";
import { WorktreeService } from "../services/worktree-service";
import { jsonSuccess } from "../utils/json-output";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "projects",
  description: "Manage the project registry",
  subcommands: [
    { name: "add", description: "Add a project to the registry", options: [{ name: "name", short: "n", type: "string", description: "Override project name" }] },
    { name: "remove", description: "Remove a project from the registry" },
    { name: "list", description: "List registered projects" },
  ],
};

export function projectsAddCommand(opts?: {
  path?: string;
  name?: string;
}): Effect.Effect<void, WctError, WctServices | "effect/unstable/cli/GlobalFlag/json"> {
  return Effect.gen(function* () {
    const json = yield* JsonFlag;
    const repoPath = resolve(opts?.path ?? process.cwd());
    const originalCwd = process.cwd();
    if (opts?.path) process.chdir(repoPath);

    const { isRepo, mainDir } = yield* Effect.ensuring(
      Effect.gen(function* () {
        const isRepo = yield* WorktreeService.use((service) =>
          service.isGitRepo(),
        );
        const mainDir = isRepo
          ? yield* WorktreeService.use((service) => service.getMainRepoPath())
          : null;
        return { isRepo, mainDir };
      }),
      Effect.sync(() => {
        if (opts?.path) process.chdir(originalCwd);
      }),
    );

    if (!isRepo) {
      return yield* Effect.fail(
        commandError("not_git_repo", `Not a git repository: ${repoPath}`),
      );
    }
    if (!mainDir) {
      return yield* Effect.fail(
        commandError("worktree_error", "Could not determine repository root"),
      );
    }

    let projectName = opts?.name ?? mainDir.split("/").pop() ?? "unknown";
    if (!opts?.name) {
      const loadResult = yield* Effect.catch(
        Effect.tryPromise({
          try: () => loadConfig(mainDir),
          catch: () => commandError("config_error", "Failed to load config"),
        }),
        () => Effect.succeed(null),
      );
      if (loadResult?.config?.project_name) {
        projectName = loadResult.config.project_name;
      }
    }

    const item = yield* RegistryService.use((service) =>
      service.register(mainDir, projectName),
    );

    if (json) {
      yield* jsonSuccess(item);
      return;
    }
    yield* logger.success(`Added ${mainDir} as '${projectName}'`);
  });
}
```

- [ ] **Step 2: Write the `projectsRemoveCommand` function**

Append to the same file:

```typescript
export function projectsRemoveCommand(
  path?: string,
): Effect.Effect<void, WctError, WctServices | "effect/unstable/cli/GlobalFlag/json"> {
  return Effect.gen(function* () {
    const json = yield* JsonFlag;
    const repoPath = resolve(path ?? process.cwd());
    const originalCwd = process.cwd();
    if (path) process.chdir(repoPath);

    const mainDir = yield* Effect.ensuring(
      Effect.catch(
        WorktreeService.use((service) => service.getMainRepoPath()),
        () => Effect.succeed(null),
      ),
      Effect.sync(() => {
        if (path) process.chdir(originalCwd);
      }),
    );

    const targetPath = mainDir ?? repoPath;

    const removed = yield* RegistryService.use((service) =>
      service.unregister(targetPath),
    );

    if (!removed) {
      return yield* Effect.fail(
        commandError(
          "registry_error",
          `Project not found in registry: ${targetPath}`,
        ),
      );
    }

    if (json) {
      yield* jsonSuccess({ repo_path: targetPath, removed: true });
      return;
    }
    yield* logger.success(`Removed ${targetPath}`);
  });
}
```

- [ ] **Step 3: Write the `projectsListCommand` function**

Append to the same file:

```typescript
export function projectsListCommand(): Effect.Effect<
  void,
  WctError,
  WctServices | "effect/unstable/cli/GlobalFlag/json"
> {
  return Effect.gen(function* () {
    const json = yield* JsonFlag;
    const repos = yield* RegistryService.use((service) => service.listRepos());

    if (json) {
      yield* jsonSuccess(repos);
      return;
    }

    if (repos.length === 0) {
      yield* logger.info("No projects registered");
      return;
    }

    const headers = ["PROJECT", "PATH"] as const;
    const colWidths = [
      Math.max(headers[0].length, ...repos.map((r) => r.project.length)),
      Math.max(headers[1].length, ...repos.map((r) => r.repo_path.length)),
    ] as const;

    yield* Console.log(
      logger.bold(
        headers
          .map((h, i) => h.padEnd(colWidths[i] as number))
          .join("  "),
      ),
    );

    for (const repo of repos) {
      yield* Console.log(
        [
          repo.project.padEnd(colWidths[0]),
          repo.repo_path.padEnd(colWidths[1]),
        ].join("  "),
      );
    }
  });
}
```

Note: `Console` is imported from `effect` at the top of the file alongside `Effect` (shown in Step 1's import block).

- [ ] **Step 4: Commit**

```bash
git add src/commands/projects.ts
git commit -m "feat: add projects command with add/remove/list functions"
```

---

### Task 2: Extend `CommandDef` for subcommands

**Files:**
- Modify: `src/commands/command-def.ts`

- [ ] **Step 1: Add optional `subcommands` field to `CommandDef`**

```typescript
export interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  args?: string;
  options?: CommandOption[];
  completionType?: "branch" | "worktree";
  subcommands?: CommandDef[];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/commands/command-def.ts
git commit -m "feat: add subcommands field to CommandDef"
```

---

### Task 3: Wire into `root-command.ts`

**Files:**
- Modify: `src/cli/root-command.ts`

- [ ] **Step 1: Replace register/unregister imports with projects imports**

Remove:
```typescript
import { registerCommand } from "../commands/register";
import { unregisterCommand } from "../commands/unregister";
```

Add:
```typescript
import {
  projectsAddCommand,
  projectsListCommand,
  projectsRemoveCommand,
} from "../commands/projects";
```

- [ ] **Step 2: Replace the `registerCliCommand` and `unregisterCliCommand` definitions**

Remove the `registerCliCommand` and `unregisterCliCommand` blocks (lines 289-313). Replace with:

```typescript
const projectsAddCliCommand = Command.make(
  "add",
  {
    path: Argument.string("path").pipe(
      Argument.withDescription("Path to repo"),
      Argument.optional,
    ),
    name: optionalStringFlag("name", "Override project name", "n", "NAME"),
  },
  ({ path, name }) =>
    projectsAddCommand({
      path: optionToUndefined(path),
      name: optionToUndefined(name),
    }),
).pipe(Command.withDescription("Add a project to the registry"));

const projectsRemoveCliCommand = Command.make(
  "remove",
  {
    path: Argument.string("path").pipe(
      Argument.withDescription("Path to repo"),
      Argument.optional,
    ),
  },
  ({ path }) => projectsRemoveCommand(optionToUndefined(path)),
).pipe(Command.withDescription("Remove a project from the registry"));

const projectsListCliCommand = Command.make(
  "list",
  {},
  () => projectsListCommand(),
).pipe(Command.withDescription("List registered projects"));

const projectsCliCommand = Command.make("projects").pipe(
  Command.withDescription("Manage the project registry"),
  Command.withSubcommands([
    projectsAddCliCommand,
    projectsRemoveCliCommand,
    projectsListCliCommand,
  ]),
);
```

- [ ] **Step 3: Update `rootCommand` subcommands array**

Replace `registerCliCommand` and `unregisterCliCommand` with `projectsCliCommand` in the `Command.withSubcommands` array:

```typescript
Command.withSubcommands([
  cdCliCommand,
  closeCliCommand,
  downCliCommand,
  hooksCliCommand,
  initCliCommand,
  listCliCommand,
  notifyCliCommand,
  openCliCommand,
  projectsCliCommand,
  switchCliCommand,
  tuiCliCommand,
  upCliCommand,
]),
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/root-command.ts
git commit -m "feat: wire projects subcommands into root command tree"
```

---

### Task 4: Update completions

**Files:**
- Modify: `src/cli/completions.ts`

- [ ] **Step 1: Replace register/unregister imports**

Remove:
```typescript
import { commandDef as registerCommandDef } from "../commands/register";
import { commandDef as unregisterCommandDef } from "../commands/unregister";
```

Add:
```typescript
import { commandDef as projectsCommandDef } from "../commands/projects";
```

- [ ] **Step 2: Update COMMANDS array**

Replace `registerCommandDef` and `unregisterCommandDef` with `projectsCommandDef`:

```typescript
const COMMANDS: ReadonlyArray<CommandDef> = [
  cdCommandDef,
  closeCommandDef,
  downCommandDef,
  hooksCommandDef,
  initCommandDef,
  listCommandDef,
  notifyCommandDef,
  openCommandDef,
  projectsCommandDef,
  switchCommandDef,
  tuiCommandDef,
  upCommandDef,
];
```

- [ ] **Step 3: Update Fish completions generator for nested subcommands**

In `generateFishCompletions()`, after the main command loop, add subcommand handling. Replace the existing command loop block (the `for (const command of COMMANDS)` that generates command completions) with:

```typescript
for (const command of COMMANDS) {
  for (const name of getAllNames(command)) {
    lines.push(
      `complete -c wct -n '__fish_use_subcommand' -a ${quoteFish(name)} -d ${quoteFish(command.description)}`,
    );
  }

  if (command.subcommands) {
    const subNames = command.subcommands.map((s) => s.name).join(" ");
    // Only show subcommand names when parent is seen but no subcommand yet
    for (const sub of command.subcommands) {
      lines.push(
        `complete -c wct -n '__fish_seen_subcommand_from ${command.name}; and not __fish_seen_subcommand_from ${subNames}' -a ${quoteFish(sub.name)} -d ${quoteFish(sub.description)}`,
      );
    }
    // Show per-subcommand options scoped to both parent and subcommand
    for (const sub of command.subcommands) {
      if (!sub.options) continue;
      for (const option of sub.options) {
        const parts = [
          "complete -c wct",
          `-n '__fish_seen_subcommand_from ${command.name}; and __fish_seen_subcommand_from ${sub.name}'`,
        ];
        if (option.short) {
          parts.push(`-s ${option.short}`);
        }
        parts.push(`-l ${option.name}`);
        if (option.type === "string") {
          parts.push("-r");
        }
        parts.push(`-d ${quoteFish(option.description)}`);
        if (option.completionValues) {
          parts.push(`-a '(${option.completionValues})'`);
        }
        lines.push(parts.join(" "));
      }
    }
  }
}
```

- [ ] **Step 4: Update Bash completions generator for nested subcommands**

In `generateBashCompletions()`, add `projects` to the command names. Then handle subcommand dispatch.

**Important:** In the existing `for (const command of COMMANDS)` loop that generates per-command `case` entries, skip commands that have `subcommands` to avoid duplicate cases:

```typescript
for (const command of COMMANDS) {
  if (command.subcommands) continue; // handled separately below
  // ... existing per-command case generation ...
}
```

Then after the loop, add the projects subcommand handling:

```typescript
// Handle commands with subcommands
for (const command of COMMANDS) {
  if (!command.subcommands) continue;
  const subNames = command.subcommands.map((s) => s.name).join(" ");
  lines.push(`        ${command.name})`);
  lines.push(`            if [[ $cword -eq 2 ]]; then`);
  lines.push(`                COMPREPLY=($(compgen -W '${subNames}' -- "$cur"))`);
  lines.push(`            else`);
  lines.push(`                local subcmd="\${COMP_WORDS[2]}"`);
  lines.push(`                case "$subcmd" in`);
  for (const sub of command.subcommands) {
    const subFlags = (sub.options ?? [])
      .flatMap((o) => [`--${o.name}`, ...(o.short ? [`-${o.short}`] : [])])
      .join(" ");
    const allFlags = subFlags
      ? `${globalFlags} ${subFlags}`
      : globalFlags;
    lines.push(`                    ${sub.name})`);
    lines.push(`                        COMPREPLY=($(compgen -W '${allFlags}' -- "$cur"))`);
    lines.push(`                        ;;`);
  }
  lines.push(`                esac`);
  lines.push(`            fi`);
  lines.push(`            ;;`);
}
```

This ensures each command appears exactly once in the bash `case` statement.

- [ ] **Step 5: Update Zsh completions generator with two-level subcommand dispatch**

In `generateZshCompletions()`, add `projects` to the commands list and handle its subcommands with a proper two-level state machine. In the `args` case, add a `projects)` branch that dispatches on `$words[2]` — showing subcommand names at level 1, and per-subcommand options at level 2:

```typescript
lines.push(`                projects)`);
lines.push(`                    if (( CURRENT == 2 )); then`);
lines.push(`                        local -a subcmds`);
lines.push(`                        subcmds=(`);
lines.push(`                            'add:Add a project to the registry'`);
lines.push(`                            'remove:Remove a project from the registry'`);
lines.push(`                            'list:List registered projects'`);
lines.push(`                        )`);
lines.push(`                        _describe 'projects subcommand' subcmds`);
lines.push(`                    else`);
lines.push(`                        case "$words[2]" in`);
lines.push(`                            add)`);
lines.push(`                                _arguments \\`);
lines.push(`                                    '(-n --name)'{-n,--name}'[Override project name]:name:' \\`);
lines.push(`                                    '*:path:_files -/'`);
lines.push(`                                ;;`);
lines.push(`                            remove)`);
lines.push(`                                _arguments '*:path:_files -/'`);
lines.push(`                                ;;`);
lines.push(`                        esac`);
lines.push(`                    fi`);
lines.push(`                    ;;`);
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/completions.ts
git commit -m "feat: update shell completions for projects subcommands"
```

---

### Task 5: Delete old files

**Files:**
- Delete: `src/commands/register.ts`
- Delete: `src/commands/unregister.ts`

- [ ] **Step 1: Delete the old command files**

```bash
rm src/commands/register.ts src/commands/unregister.ts
```

- [ ] **Step 2: Verify no remaining imports reference the deleted files**

```bash
grep -r "commands/register\|commands/unregister" src/
```

Expected: no output (all references already replaced in prior tasks).

- [ ] **Step 3: Commit**

```bash
git add -u src/commands/register.ts src/commands/unregister.ts
git commit -m "chore: remove register and unregister commands"
```

---

### Task 6: Update tests

**Files:**
- Modify: `tests/completions.test.ts`

- [ ] **Step 1: Update completions test assertions**

In `tests/completions.test.ts`, the test `"renders built-in help from the root command"` checks for subcommands in the help output. Update any assertions that reference `register` or `unregister` to reference `projects` instead.

The test at line 11 checks `--help` output. Add an assertion for `projects`:

```typescript
expect(output).toContain("projects");
```

And ensure no assertion expects `register` or `unregister` as top-level commands. Currently none do explicitly, so this is just a verification step.

- [ ] **Step 2: Update Fish completions test**

The test at line 70 checks Fish completions output. Update:

```typescript
expect(output).not.toContain("-a 'register'");
expect(output).not.toContain("-a 'unregister'");
expect(output).toContain("-a 'projects'");
```

- [ ] **Step 3: Update Bash completions test**

The test at line 83 (`"renders bash completions with command-specific options after a subcommand"`) asserts a specific `COMPREPLY` line. This test checks the `open` subcommand's options line, which is not affected by the rename. However, the top-level command names `compgen -W` line (generated by `if [[ $cword -eq 1 ]]`) changes because `register` and `unregister` are replaced with `projects`. If any test assertion checks the top-level command list string, update it. Currently none do — so verify the test still passes as-is.

- [ ] **Step 4: Add JSON output tests for projects subcommands**

Add a new test file `tests/projects.test.ts`:

```typescript
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

function runCliProcess(args: string[]) {
  return Bun.spawnSync(["bun", "run", "src/index.ts", ...args]);
}

describe("projects command", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `wct-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("projects list --json returns envelope with empty array", () => {
    const result = runCliProcess(["--json", "projects", "list"]);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, data: [] });
  });

  test("projects add --json returns envelope with registry item", () => {
    const result = runCliProcess(["--json", "projects", "add"]);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual(
      expect.objectContaining({
        repo_path: expect.any(String),
        project: expect.any(String),
        id: expect.any(String),
        created_at: expect.any(Number),
      }),
    );
  });

  test("projects remove --json returns envelope with removed status", () => {
    // First add a project
    runCliProcess(["projects", "add"]);

    const result = runCliProcess(["--json", "projects", "remove"]);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.removed).toBe(true);
    expect(parsed.data.repo_path).toEqual(expect.any(String));
  });

  test("projects --help shows subcommands", () => {
    const result = runCliProcess(["projects", "--help"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain("add");
    expect(output).toContain("remove");
    expect(output).toContain("list");
  });
});
```

- [ ] **Step 5: Run tests**

```bash
bun run test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/completions.test.ts tests/projects.test.ts
git commit -m "test: update completions tests and add projects command tests"
```

---

### Task 7: Manual smoke test

- [ ] **Step 1: Verify help output**

```bash
bun run src/index.ts projects --help
```

Expected: shows `add`, `remove`, `list` subcommands.

- [ ] **Step 2: Verify add**

```bash
bun run src/index.ts projects add
```

Expected: registers current repo (or fails with "not a git repository" if not in a repo).

- [ ] **Step 3: Verify list**

```bash
bun run src/index.ts projects list
```

Expected: shows the registered project in a table.

- [ ] **Step 4: Verify JSON output**

```bash
bun run src/index.ts --json projects list
```

Expected: `{ ok: true, data: [...] }` envelope wrapping registry items.

- [ ] **Step 5: Verify remove**

```bash
bun run src/index.ts projects remove
```

Expected: removes the project and logs success.

- [ ] **Step 6: Verify old commands are gone**

```bash
bun run src/index.ts register
```

Expected: `Unknown subcommand "register"` error.

---

### Post-Implementation Notes

- `src/commands/projects.ts` diverged from the literal plan in a few places for robustness:
  - `projectsAddCommand` and `projectsRemoveCommand` now wrap `process.cwd()` / `process.chdir()` in typed `Effect.try(...)` helpers so invalid cwd/path failures stay in the `WctError` channel instead of escaping as defects.
  - `projectsAddCommand` now calls `WorktreeService.getMainRepoPath()` directly and treats `null` as the non-repo case, instead of using the plan's broader outer `Effect.catch(... => Effect.succeed(null))`. This preserves real `worktree_error` failures.
  - `projectsRemoveCommand` currently also calls `WorktreeService.getMainRepoPath()` directly without the plan's broader outer catch. This is an implementation difference that affects whether Git-resolution failures fall back to raw `repoPath` unregister behavior.
  - `projectsAddCommand` still falls back to `basename(mainDir)` when config loading or validation fails, matching the original plan's behavior after a later regression fix. Invalid config is not treated as a hard blocker for registration.

- `src/commands/command-def.ts` was extended beyond the plan's literal type snippet:
  - `completionType` now supports `"path"` in addition to `"branch"` and `"worktree"`, so nested subcommands can drive path completions from metadata.

- `src/cli/completions.ts` diverged from the literal plan in service of correctness and coverage:
  - Fish and Bash now emit path completions for `projects add` and `projects remove` based on `completionType: "path"`.
  - Bash and Zsh no longer assume the nested subcommand is always at `COMP_WORDS[2]` / `words[2]`; they scan for the first non-flag token after the grouped command so global flags before `projects` do not break nested completion dispatch.
  - Zsh completions are now generated from command metadata rather than hardcoded to `projects`, even though the original plan showed a hardcoded branch.

- Test coverage in `tests/projects.test.ts` and `tests/completions.test.ts` also extends beyond the original plan:
  - Added coverage for `--json projects list`.
  - Added end-to-end coverage for `projects add` / `projects remove` when no repo path is passed and the commands rely on `process.cwd()`.
  - Added regression coverage for malformed config fallback behavior in `projects add`.
  - Added assertions for nested fish, bash, and zsh completion fragments, including `projects add` option/path completion output.

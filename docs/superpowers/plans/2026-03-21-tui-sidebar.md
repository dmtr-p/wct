# TUI Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive TUI sidebar (`wct tui`) that displays repos and worktrees in a tree view, with actions to switch tmux sessions, open/close worktrees, and jump to notification panes.

**Architecture:** Ink/React TUI lazy-loaded behind a new `wct tui` Effect CLI subcommand. A unified SQLite database (`~/.wct/wct.db`) stores a repo registry and notification queue. The TUI discovers worktrees via `git worktree list`, enriches with live status, and controls a tmux client in an adjacent terminal pane.

**Tech Stack:** Effect v4, Ink 5, React 18, Bun SQLite, vitest

**Spec:** `docs/superpowers/specs/2026-03-21-tui-sidebar-design.md`

---

### Task 1: Update CLAUDE.md and project docs

Update documentation first so agents working on later tasks understand the new dependency policy and architecture.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `EFFECT_V4.md` (add note about JSX/React coexistence if needed)

- [ ] **Step 1: Update CLAUDE.md runtime dependency policy**

In `CLAUDE.md`, find line 85:
```
The only runtime dependencies are `effect` and `@effect/platform-bun`. No other runtime dependencies should be added.
```

Replace with:
```
The only runtime dependencies are `effect` and `@effect/platform-bun`. No other runtime dependencies should be added. Exception: `ink` and `react` are runtime dependencies used exclusively by the `wct tui` subcommand. They are lazy-imported so they are never loaded for other commands.
```

- [ ] **Step 2: Add TUI section to CLAUDE.md Architecture**

After the existing file structure in CLAUDE.md, add the `src/tui/` tree:

```
├── tui/
│   ├── App.tsx            # Root Ink component, data fetching, keyboard routing
│   ├── components/
│   │   ├── TreeView.tsx   # Collapsible repo/worktree list
│   │   ├── RepoNode.tsx   # Single repo group
│   │   ├── WorktreeItem.tsx # Branch line with status indicators
│   │   ├── OpenModal.tsx  # Modal for wct open
│   │   ├── StatusBar.tsx  # Bottom keybinding hints
│   │   └── Modal.tsx      # Generic modal wrapper
│   └── hooks/
│       ├── useRegistry.ts # Fetch repos from DB, discover worktrees via git
│       ├── useQueue.ts    # Fetch notifications from DB
│       ├── useRefresh.ts  # Hybrid poll + fs.watch
│       └── useTmux.ts     # switch-client, list-clients
```

Also add `tui.ts` under `commands/` in the existing command list and `registry-service.ts` + `worktree-status.ts` under `services/`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for TUI sidebar architecture and deps"
```

---

### Task 2: Install Ink and React dependencies

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json` (verify JSX config)

- [ ] **Step 1: Install dependencies**

```bash
bun add ink react
bun add -d @types/react
```

- [ ] **Step 2: Verify tsconfig.json supports JSX**

Read `tsconfig.json`. It should already have `"jsx": "react-jsx"` (line 8). If present, no change needed. If not, add it to `compilerOptions`.

- [ ] **Step 3: Verify build works**

```bash
bun run src/index.ts --help
```

Expected: normal help output, no import errors.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock tsconfig.json
git commit -m "feat: add ink and react dependencies for TUI sidebar"
```

---

### Task 3: Extract worktree-status service from list command

Extract the reusable status-checking functions from `src/commands/list.ts` into a standalone service so both `wct list` and the TUI can use them.

**Files:**
- Create: `src/services/worktree-status.ts`
- Create: `tests/services/worktree-status.test.ts`
- Modify: `src/commands/list.ts`

- [ ] **Step 1: Write tests for worktree-status**

```typescript
// tests/services/worktree-status.test.ts
import { describe, expect, test } from "vitest";
import { formatChanges, formatSync } from "../../src/services/worktree-status";

describe("formatSync", () => {
  test("returns checkmark when in sync", () => {
    expect(formatSync({ ahead: 0, behind: 0 })).toBe("\u2713");
  });

  test("returns up arrow with count when ahead", () => {
    expect(formatSync({ ahead: 3, behind: 0 })).toBe("\u21913");
  });

  test("returns down arrow with count when behind", () => {
    expect(formatSync({ ahead: 0, behind: 2 })).toBe("\u21932");
  });

  test("returns both arrows when ahead and behind", () => {
    expect(formatSync({ ahead: 1, behind: 3 })).toBe("\u21911 \u21933");
  });

  test("returns ? when sync is null", () => {
    expect(formatSync(null)).toBe("?");
  });
});

describe("formatChanges", () => {
  test("returns singular for 1 file", () => {
    expect(formatChanges(1)).toBe("1 file");
  });

  test("returns plural for multiple files", () => {
    expect(formatChanges(3)).toBe("3 files");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/services/worktree-status.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create worktree-status.ts**

Move `getChangedFilesCount`, `getDefaultBranch`, `getAheadBehind`, `formatSync`, and `formatChanges` from `src/commands/list.ts` into `src/services/worktree-status.ts`. Keep the same signatures and imports.

```typescript
// src/services/worktree-status.ts
import { Effect } from "effect";
import type { WctError } from "../errors";
import { execProcess } from "./process";
import * as logger from "../utils/logger";

export function getChangedFilesCount(worktreePath: string) {
  return Effect.catch(
    execProcess("git", ["status", "--porcelain"], {
      cwd: worktreePath,
    }).pipe(
      Effect.map((result) => {
        const output = result.stdout.trim();
        if (!output) return 0;
        return output.split("\n").length;
      }),
    ),
    (error) =>
      logger
        .warn(
          `Failed to get changes for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .pipe(Effect.as(0)),
  );
}

export function getDefaultBranch(repoPath: string) {
  return Effect.gen(function* () {
    const ref = yield* Effect.catch(
      execProcess("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
        cwd: repoPath,
      }).pipe(Effect.map((result) => result.stdout.trim())),
      () => Effect.succeed(null),
    );
    if (ref) {
      return ref.replace("refs/remotes/origin/", "");
    }

    for (const candidate of ["main", "master"]) {
      const exists = yield* Effect.catch(
        execProcess("git", ["rev-parse", "--verify", candidate], {
          cwd: repoPath,
        }).pipe(Effect.as(true)),
        () => Effect.succeed(false),
      );
      if (exists) {
        return candidate;
      }
    }
    return null;
  });
}

export function getAheadBehind(
  worktreePath: string,
  defaultBranch: string | null,
) {
  if (!defaultBranch) {
    return Effect.succeed(null);
  }

  return Effect.catch(
    execProcess(
      "git",
      ["rev-list", "--left-right", "--count", `HEAD...${defaultBranch}`],
      { cwd: worktreePath },
    ).pipe(
      Effect.map((result) => {
        const [ahead, behind] = result.stdout
          .trim()
          .split(/\s+/)
          .map((n: string) => {
            const parsed = Number.parseInt(n, 10);
            return Number.isNaN(parsed) ? 0 : parsed;
          });
        return { ahead: ahead ?? 0, behind: behind ?? 0 };
      }),
    ),
    (error) =>
      logger
        .warn(
          `Failed to get sync status for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .pipe(Effect.as(null)),
  );
}

export function formatChanges(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

export function formatSync(
  sync: { ahead: number; behind: number } | null,
): string {
  if (!sync) return "?";
  const { ahead, behind } = sync;
  if (ahead === 0 && behind === 0) return "\u2713";
  const parts: string[] = [];
  if (ahead > 0) parts.push(`\u2191${ahead}`);
  if (behind > 0) parts.push(`\u2193${behind}`);
  return parts.join(" ");
}
```

- [ ] **Step 4: Update list.ts to import from worktree-status**

Replace the function definitions in `src/commands/list.ts` (lines 24-119) with imports:

```typescript
import {
  formatChanges,
  formatSync,
  getAheadBehind,
  getChangedFilesCount,
  getDefaultBranch,
} from "../services/worktree-status";
```

Remove the `execProcess` import from list.ts (no longer needed directly). Keep the `commandError` import.

- [ ] **Step 5: Run all tests**

```bash
bun test
```

Expected: all pass, including the new worktree-status tests.

- [ ] **Step 6: Verify list command still works**

```bash
bun run src/index.ts list
```

Expected: same output as before.

- [ ] **Step 7: Commit**

```bash
git add src/services/worktree-status.ts tests/services/worktree-status.test.ts src/commands/list.ts
git commit -m "refactor: extract worktree-status service from list command"
```

---

### Task 4: Migrate queue-storage to unified wct.db

Change the database path from `~/.wct/queue.db` to `~/.wct/wct.db` and add cleanup of the old DB file.

**Files:**
- Modify: `src/services/queue-storage.ts`
- Modify: existing queue-storage tests (if any)

- [ ] **Step 1: Write test for DB path change**

Check if there are existing queue-storage tests. If so, verify they still pass after the change. If not, add a simple test:

```bash
bun test --reporter=verbose 2>&1 | grep -i queue
```

- [ ] **Step 2: Update getDbPath in queue-storage.ts**

In `src/services/queue-storage.ts`, change `getDbPath()` (line 12-14):

```typescript
function getDbPath(): string {
  return `${getQueueDir()}/wct.db`;
}
```

- [ ] **Step 3: Add old DB cleanup**

Add a cleanup function and call it in `withDbSync` before creating the DB. After the `mkdirSync` call (line 70), add:

Add `existsSync` and `unlinkSync` to the existing `import { mkdirSync } from "node:fs"` line:

```typescript
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
```

Then add the cleanup function:

```typescript
function cleanupOldDb(): void {
  const oldPath = `${getQueueDir()}/queue.db`;
  const newPath = getDbPath();
  try {
    if (!existsSync(newPath) && existsSync(oldPath)) {
      unlinkSync(oldPath);
      for (const suffix of ["-wal", "-shm"]) {
        try {
          unlinkSync(oldPath + suffix);
        } catch {}
      }
    }
  } catch {}
}
```

Call `cleanupOldDb()` right after `mkdirSync` in `withDbSync`.

- [ ] **Step 4: Run tests**

```bash
bun test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/queue-storage.ts
git commit -m "feat: migrate queue storage from queue.db to unified wct.db"
```

---

### Task 5: Create registry service

**Files:**
- Create: `src/services/registry-service.ts`
- Create: `tests/services/registry-service.test.ts`
- Modify: `src/effect/services.ts`

- [ ] **Step 1: Write tests for registry service**

```typescript
// tests/services/registry-service.test.ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// We'll test the pure DB operations by setting HOME to a temp dir
describe("registry-service", () => {
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

  test("register and list repos", async () => {
    const { liveRegistryService } = await import(
      "../../src/services/registry-service"
    );
    const { Effect } = await import("effect");

    const item = await Effect.runPromise(
      liveRegistryService.register("/tmp/fake-repo", "test-project"),
    );
    expect(item.repo_path).toBe("/tmp/fake-repo");
    expect(item.project).toBe("test-project");

    const repos = await Effect.runPromise(liveRegistryService.listRepos());
    expect(repos.length).toBeGreaterThanOrEqual(1);
    expect(repos.find((r) => r.repo_path === "/tmp/fake-repo")).toBeDefined();

    const removed = await Effect.runPromise(
      liveRegistryService.unregister("/tmp/fake-repo"),
    );
    expect(removed).toBe(true);
  });

  test("register is idempotent and updates project name", async () => {
    const { liveRegistryService } = await import(
      "../../src/services/registry-service"
    );
    const { Effect } = await import("effect");

    await Effect.runPromise(
      liveRegistryService.register("/tmp/idem-repo", "old-name"),
    );
    const updated = await Effect.runPromise(
      liveRegistryService.register("/tmp/idem-repo", "new-name"),
    );
    expect(updated.project).toBe("new-name");

    await Effect.runPromise(
      liveRegistryService.unregister("/tmp/idem-repo"),
    );
  });

  test("unregister returns false for unknown path", async () => {
    const { liveRegistryService } = await import(
      "../../src/services/registry-service"
    );
    const { Effect } = await import("effect");

    const removed = await Effect.runPromise(
      liveRegistryService.unregister("/tmp/does-not-exist"),
    );
    expect(removed).toBe(false);
  });
});
```

Note: Full Effect service tests require running Effect programs. Write integration-style tests that exercise the service through Effect.runPromise after implementing.

- [ ] **Step 2: Create registry-service.ts**

```typescript
// src/services/registry-service.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { Effect, ServiceMap } from "effect";
import { commandError, type WctError } from "../errors";

function getWctDir(): string {
  return `${process.env.HOME ?? "/tmp"}/.wct`;
}

function getDbPath(): string {
  return `${getWctDir()}/wct.db`;
}

export interface RegistryItem {
  id: string;
  repo_path: string;
  project: string;
  created_at: number;
}

export interface RegistryServiceApi {
  register: (
    repoPath: string,
    project: string,
  ) => Effect.Effect<RegistryItem, WctError>;
  unregister: (repoPath: string) => Effect.Effect<boolean, WctError>;
  listRepos: () => Effect.Effect<RegistryItem[], WctError>;
  findByPath: (
    repoPath: string,
  ) => Effect.Effect<RegistryItem | null, WctError>;
}

export const RegistryService =
  ServiceMap.Service<RegistryServiceApi>("wct/RegistryService");

const REGISTRY_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS registry (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

function generateId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function withDb<A>(
  operation: string,
  f: (db: Database) => A,
): Effect.Effect<A, WctError> {
  return Effect.try({
    try: () => {
      mkdirSync(getWctDir(), { recursive: true });
      const db = new Database(getDbPath(), { create: true });
      db.run("PRAGMA journal_mode=WAL");
      db.run(REGISTRY_SCHEMA_SQL);
      try {
        return f(db);
      } finally {
        db.close();
      }
    },
    catch: (error) =>
      commandError(
        "registry_error",
        `Registry database operation failed during ${operation}`,
        error,
      ),
  });
}

export const liveRegistryService: RegistryServiceApi = RegistryService.of({
  register: (repoPath, project) =>
    Effect.gen(function* () {
      const existing = yield* withDb("check existing", (db) => {
        return db
          .query("SELECT * FROM registry WHERE repo_path = ?")
          .get(repoPath) as RegistryItem | null;
      });

      if (existing) {
        // Update project name if changed
        if (existing.project !== project) {
          yield* withDb("update project", (db) => {
            db.run("UPDATE registry SET project = ? WHERE repo_path = ?", [
              project,
              repoPath,
            ]);
          });
        }
        return { ...existing, project };
      }

      const id = generateId();
      const created_at = Date.now();
      const item: RegistryItem = { id, repo_path: repoPath, project, created_at };

      yield* withDb("register repo", (db) => {
        db.run(
          "INSERT INTO registry (id, repo_path, project, created_at) VALUES (?, ?, ?, ?)",
          [id, repoPath, project, created_at],
        );
      });

      return item;
    }),

  unregister: (repoPath) =>
    withDb("unregister repo", (db) => {
      const result = db.run("DELETE FROM registry WHERE repo_path = ?", [
        repoPath,
      ]);
      return result.changes > 0;
    }),

  listRepos: () =>
    withDb("list repos", (db) => {
      return db
        .query("SELECT * FROM registry ORDER BY project ASC")
        .all() as RegistryItem[];
    }),

  findByPath: (repoPath) =>
    withDb("find repo", (db) => {
      return (
        (db
          .query("SELECT * FROM registry WHERE repo_path = ?")
          .get(repoPath) as RegistryItem | null) ?? null
      );
    }),
});
```

- [ ] **Step 3: Add registry_error to error types**

In `src/errors.ts`, add `"registry_error"` to the `ErrorCode` type union (after line 24 `| "notify_error"`):

```typescript
  | "notify_error"
  | "registry_error";
```

- [ ] **Step 4: Register service in services.ts**

In `src/effect/services.ts`:

Add import:
```typescript
import {
  liveRegistryService,
  RegistryService,
  type RegistryServiceApi,
} from "../services/registry-service";
```

Add `RegistryServiceApi` to the `WctServices` union type.

Add provision in `provideWctServices` — wrap the existing innermost `Effect.provideService` call:
```typescript
Effect.provideService(
  Effect.provideService(effect, GitHubService, liveGitHubService),
  RegistryService,
  liveRegistryService,
),
```

- [ ] **Step 5: Run tests**

```bash
bun test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/registry-service.ts tests/services/registry-service.test.ts src/effect/services.ts src/errors.ts
git commit -m "feat: add registry service for repo tracking"
```

---

### Task 6: Add register and unregister commands

**Files:**
- Create: `src/commands/register.ts`
- Create: `src/commands/unregister.ts`
- Modify: `src/cli/root-command.ts`
- Modify: `src/cli/completions.ts` (if it has a command list)

- [ ] **Step 1: Create register command**

```typescript
// src/commands/register.ts
import { Effect } from "effect";
import { loadConfig } from "../config/loader";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { RegistryService } from "../services/registry-service";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "register",
  description: "Register a repo in the TUI registry",
};

export function registerCommand(
  path?: string,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const repoPath = path ?? process.cwd();

    const isRepo = yield* WorktreeService.use((service) => service.isGitRepo());
    if (!isRepo) {
      return yield* Effect.fail(
        commandError("not_git_repo", `Not a git repository: ${repoPath}`),
      );
    }

    const mainDir = yield* WorktreeService.use((service) =>
      service.getMainRepoPath(),
    );
    if (!mainDir) {
      return yield* Effect.fail(
        commandError("worktree_error", "Could not determine repository root"),
      );
    }

    // Try to detect project name from config
    let projectName = mainDir.split("/").pop() ?? "unknown";
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

    yield* RegistryService.use((service) =>
      service.register(mainDir, projectName),
    );

    yield* logger.success(`Registered ${mainDir} as '${projectName}'`);
  });
}
```

- [ ] **Step 2: Create unregister command**

```typescript
// src/commands/unregister.ts
import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { RegistryService } from "../services/registry-service";
import { WorktreeService } from "../services/worktree-service";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "unregister",
  description: "Remove a repo from the TUI registry",
};

export function unregisterCommand(
  path?: string,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const repoPath = path ?? process.cwd();

    const mainDir = yield* WorktreeService.use((service) =>
      service.getMainRepoPath(),
    );

    const targetPath = mainDir ?? repoPath;

    const removed = yield* RegistryService.use((service) =>
      service.unregister(targetPath),
    );

    if (!removed) {
      return yield* Effect.fail(
        commandError("registry_error", `Repo not found in registry: ${targetPath}`),
      );
    }

    yield* logger.success(`Unregistered ${targetPath}`);
  });
}
```

- [ ] **Step 3: Add CLI commands to root-command.ts**

Add imports at the top of `src/cli/root-command.ts`:
```typescript
import { registerCommand } from "../commands/register";
import { unregisterCommand } from "../commands/unregister";
```

Add CLI command definitions (before `rootCommand`):
```typescript
const registerCliCommand = Command.make(
  "register",
  {
    path: Argument.string("path").pipe(Argument.withDescription("Path to repo"), Argument.optional),
  },
  ({ path }) => registerCommand(optionToUndefined(path)),
).pipe(Command.withDescription("Register a repo in the TUI registry"));

const unregisterCliCommand = Command.make(
  "unregister",
  {
    path: Argument.string("path").pipe(Argument.withDescription("Path to repo"), Argument.optional),
  },
  ({ path }) => unregisterCommand(optionToUndefined(path)),
).pipe(Command.withDescription("Remove a repo from the TUI registry"));
```

Add both to `withSubcommands` array (line 335-347):
```typescript
registerCliCommand,
unregisterCliCommand,
```

- [ ] **Step 4: Update completions if needed**

Check `src/cli/completions.ts` for a command list. If it has one, add `register` and `unregister`.

- [ ] **Step 5: Test the commands**

```bash
bun run src/index.ts register --help
bun run src/index.ts unregister --help
```

Expected: help output with correct descriptions.

- [ ] **Step 6: Commit**

```bash
git add src/commands/register.ts src/commands/unregister.ts src/cli/root-command.ts src/cli/completions.ts
git commit -m "feat: add register and unregister commands for TUI repo registry"
```

---

### Task 7: Auto-register repos in open and init commands

**Files:**
- Modify: `src/commands/open.ts`
- Modify: `src/commands/init.ts`

- [ ] **Step 1: Add registration to open.ts**

In `src/commands/open.ts`, after the config is loaded and resolved (around line 126, after the profile resolution block), add:

```typescript
import { RegistryService } from "../services/registry-service";
```

And inside `openCommand`, after config loading succeeds (after line 126), add:

```typescript
    // Auto-register repo in TUI registry
    yield* Effect.catch(
      RegistryService.use((service) =>
        service.register(mainDir, resolved.project_name ?? basename(mainDir)),
      ),
      () => Effect.void,
    );
```

- [ ] **Step 2: Add registration to init.ts**

In `src/commands/init.ts`, after writing the config file (after line 83), add:

```typescript
import { RegistryService } from "../services/registry-service";
import { WorktreeService } from "../services/worktree-service";
import { basename } from "node:path";
```

After `logger.success("Created ${CONFIG_FILENAME}")` (line 85), add:

```typescript
    // Auto-register repo in TUI registry
    const mainDir = yield* Effect.catch(
      WorktreeService.use((service) => service.getMainRepoPath()),
      () => Effect.succeed(null),
    );
    if (mainDir) {
      yield* Effect.catch(
        RegistryService.use((service) =>
          service.register(mainDir, basename(mainDir)),
        ),
        () => Effect.void,
      );
    }
```

- [ ] **Step 3: Verify open still works**

```bash
bun run src/index.ts open --help
```

Expected: help output unchanged.

- [ ] **Step 4: Run tests**

```bash
bun test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/open.ts src/commands/init.ts
git commit -m "feat: auto-register repos in TUI registry on open and init"
```

---

### Task 8: Remove queue interactive mode, C-q binding, and status bar notifications

**Files:**
- Modify: `src/commands/queue.ts`
- Modify: `src/cli/root-command.ts`
- Modify: `src/services/tmux.ts`

- [ ] **Step 1: Remove interactive mode from queue.ts**

In `src/commands/queue.ts`:
- Remove the `interactiveMode` function (lines 127-238)
- Remove the `createInterface` import from `node:readline` (line 1)
- Remove the `interactive` option from `commandDef.options` (lines 24-29)
- Remove `interactive` from the `QueueOptions` interface (line 52)
- Remove the `if (options.interactive)` block in `queueCommand` (lines 300-303)

- [ ] **Step 2: Remove interactive flag from root-command.ts**

In `src/cli/root-command.ts`, update the `queueCliCommand` definition (lines 126-157):
- Remove the `interactive` flag definition (lines 130-134)
- Remove `interactive` from the destructured args and the `queueCommand()` call

- [ ] **Step 3: Remove C-q binding and status bar from tmux.ts**

In `src/services/tmux.ts`:
- Remove the `configureQueueStatusBar` function (lines 399-451)
- Remove calls to `configureQueueStatusBar(name)` in `createSessionImpl` (lines 461 and 474)
- Remove the `planQueueStatusRightUpdate` function (lines 359-397)
- Remove the `getSessionLocalStatusRight` and `getGlobalStatusRight` helper functions (lines 338-357)
- Remove the `resolveWctBin` and `formatShellCommand` imports/usages if they become unused after this removal

- [ ] **Step 4: Remove the queue --count flag and commandDef entry**

In `src/commands/queue.ts`:
- Remove the `count` option from `commandDef.options` (lines 18-22)
- Remove `count` from `QueueOptions` interface
- Remove the `formatCount` function (lines 78-81)
- Remove the `if (options.count)` block in `queueCommand` (lines 245-257)

In `src/cli/root-command.ts`:
- Remove the `count` flag from `queueCliCommand`

- [ ] **Step 5: Remove tests for removed functions**

In `tests/tmux.test.ts`: remove the `describe("planQueueStatusRightUpdate", ...)` block (starts around line 83) and remove the `planQueueStatusRightUpdate` import (line 7).

In `tests/queue-service.test.ts`: remove the `formatCount` function definition (line 77) and the `describe("formatCount", ...)` block (starts around line 82).

- [ ] **Step 6: Run tests**

```bash
bun test
```

Expected: all pass with removed test blocks gone.

- [ ] **Step 7: Verify queue command still works**

```bash
bun run src/index.ts queue --help
```

Expected: help output shows only `--jump`, `--dismiss`, `--clear`.

- [ ] **Step 8: Commit**

```bash
git add src/commands/queue.ts src/cli/root-command.ts src/services/tmux.ts tests/tmux.test.ts tests/queue-service.test.ts
git commit -m "feat: remove interactive queue, C-q binding, and status bar notifications

These features are replaced by the TUI sidebar."
```

---

### Task 9: Create TUI command entry point

**Files:**
- Create: `src/commands/tui.ts`
- Create: `src/tui/App.tsx`
- Modify: `src/cli/root-command.ts`

- [ ] **Step 1: Create minimal App.tsx**

Start with a minimal Ink app that just renders a title:

```tsx
// src/tui/App.tsx
import React from "react";
import { render, Text, Box } from "ink";

export function App() {
  return (
    <Box flexDirection="column">
      <Text bold>wct</Text>
      <Text dimColor>Loading...</Text>
    </Box>
  );
}

export function startTui() {
  render(<App />);
}
```

- [ ] **Step 2: Create tui.ts command**

```typescript
// src/commands/tui.ts
import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import type { WctError } from "../errors";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "tui",
  description: "Interactive TUI sidebar for managing worktrees",
};

export function tuiCommand(): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const { startTui } = yield* Effect.promise(() => import("../tui/App"));
    startTui();
    // Keep the process alive until Ink exits
    yield* Effect.never;
  });
}
```

- [ ] **Step 3: Register in root-command.ts**

Add import:
```typescript
import { tuiCommand } from "../commands/tui";
```

Add CLI command:
```typescript
const tuiCliCommand = Command.make("tui", {}, () => tuiCommand()).pipe(
  Command.withDescription("Interactive TUI sidebar for managing worktrees"),
);
```

Add to `withSubcommands` array.

- [ ] **Step 4: Test it launches**

```bash
bun run src/index.ts tui
```

Expected: Shows "wct" and "Loading..." then hangs (Ctrl+C to exit). This confirms lazy import works.

- [ ] **Step 5: Commit**

```bash
git add src/commands/tui.ts src/tui/App.tsx src/cli/root-command.ts
git commit -m "feat: add wct tui command with minimal Ink app"
```

---

### Task 10: Implement useRegistry hook with worktree discovery

**Files:**
- Create: `src/tui/hooks/useRegistry.ts`
- Create: `tests/tui/hooks/useRegistry.test.ts`

- [ ] **Step 1: Define data types**

```typescript
// src/tui/hooks/useRegistry.ts
import { useCallback, useEffect, useState } from "react";
import { Effect } from "effect";
import type { RegistryItem } from "../../services/registry-service";
import { liveRegistryService } from "../../services/registry-service";
import { execProcess } from "../../services/process";

export interface WorktreeInfo {
  branch: string;
  path: string;
  isMainWorktree: boolean;
}

export interface RepoInfo {
  id: string;
  repoPath: string;
  project: string;
  worktrees: WorktreeInfo[];
  error?: string; // set if repo path is missing
}

async function discoverWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  try {
    const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of text.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) {
          worktrees.push(current as WorktreeInfo);
        }
        current = { path: line.slice(9), isMainWorktree: false };
      } else if (line.startsWith("branch refs/heads/")) {
        current.branch = line.slice(18);
      } else if (line === "bare") {
        current = {};
      } else if (line.startsWith("HEAD ")) {
        // detached HEAD — use short SHA as branch display
        if (!current.branch) {
          current.branch = `(detached)`;
        }
      }
    }
    if (current.path && current.branch) {
      worktrees.push(current as WorktreeInfo);
    }

    // Mark first worktree as main
    if (worktrees.length > 0) {
      worktrees[0]!.isMainWorktree = true;
    }

    return worktrees;
  } catch {
    return [];
  }
}

export function useRegistry() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const items = await Effect.runPromise(liveRegistryService.listRepos());
      const repoInfos: RepoInfo[] = await Promise.all(
        items.map(async (item) => {
          const { existsSync } = await import("node:fs");
          if (!existsSync(item.repo_path)) {
            return {
              id: item.id,
              repoPath: item.repo_path,
              project: item.project,
              worktrees: [],
              error: "Directory not found",
            };
          }
          const worktrees = await discoverWorktrees(item.repo_path);
          return {
            id: item.id,
            repoPath: item.repo_path,
            project: item.project,
            worktrees,
          };
        }),
      );
      setRepos(repoInfos);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { repos, loading, refresh };
}
```

- [ ] **Step 2: Run lint**

```bash
bunx biome check --write src/tui/
```

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/useRegistry.ts
git commit -m "feat: add useRegistry hook with worktree discovery"
```

---

### Task 11: Implement useQueue and useRefresh hooks

**Files:**
- Create: `src/tui/hooks/useQueue.ts`
- Create: `src/tui/hooks/useRefresh.ts`

- [ ] **Step 1: Create useQueue hook**

```typescript
// src/tui/hooks/useQueue.ts
import { useCallback, useEffect, useState } from "react";
import { Effect } from "effect";
import { liveQueueStorage, type QueueItem } from "../../services/queue-storage";

export function useQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await Effect.runPromise(
        liveQueueStorage.listItems({ validatePanes: true, logWarnings: false }),
      );
      setItems(result);
    } catch {
      // Silently fail on queue read errors
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { items, refresh };
}
```

- [ ] **Step 2: Create useRefresh hook**

```typescript
// src/tui/hooks/useRefresh.ts
import { useEffect, useRef } from "react";
import { watch } from "node:fs";

const POLL_INTERVAL_MS = 5000;

export function useRefresh(onRefresh: () => void | Promise<void>) {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    // Slow poll fallback
    const interval = setInterval(() => {
      refreshRef.current();
    }, POLL_INTERVAL_MS);

    // Watch ~/.wct/ directory for DB changes
    const wctDir = `${process.env.HOME ?? "/tmp"}/.wct`;
    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(wctDir, (eventType, filename) => {
        if (filename && (filename.endsWith(".db") || filename.endsWith("-wal"))) {
          refreshRef.current();
        }
      });
    } catch {
      // Directory may not exist yet — poll will still work
    }

    return () => {
      clearInterval(interval);
      watcher?.close();
    };
  }, []);
}
```

- [ ] **Step 3: Run lint**

```bash
bunx biome check --write src/tui/
```

- [ ] **Step 4: Commit**

```bash
git add src/tui/hooks/useQueue.ts src/tui/hooks/useRefresh.ts
git commit -m "feat: add useQueue and useRefresh hooks for TUI"
```

---

### Task 12: Implement useTmux hook

**Files:**
- Create: `src/tui/hooks/useTmux.ts`

- [ ] **Step 1: Create useTmux hook**

```typescript
// src/tui/hooks/useTmux.ts
import { useCallback, useEffect, useState } from "react";

interface TmuxClient {
  tty: string;
  session: string;
}

export interface TmuxSessionInfo {
  name: string;
  attached: boolean;
}

async function runTmux(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`tmux ${args[0]} failed`);
  }
  return text.trim();
}

export function useTmux() {
  const [client, setClient] = useState<TmuxClient | null>(null);
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const output = await runTmux([
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_attached}",
      ]);
      const parsed = output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, attached] = line.split("\t");
          return { name: name!, attached: attached === "1" };
        });
      setSessions(parsed);
    } catch {
      setSessions([]);
    }
  }, []);

  const discoverClient = useCallback(async () => {
    try {
      const output = await runTmux([
        "list-clients",
        "-F",
        "#{client_tty}\t#{client_session}",
      ]);
      const clients = output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [tty, session] = line.split("\t");
          return { tty: tty!, session: session! };
        });

      if (clients.length === 0) {
        setError("No tmux client found — start tmux in the other pane");
        setClient(null);
      } else if (clients.length === 1) {
        setClient(clients[0]!);
        setError(null);
      } else {
        setError(`Multiple tmux clients found (${clients.length}). Multi-client support coming soon.`);
        setClient(null);
      }
    } catch {
      setError("No tmux client found — start tmux in the other pane");
      setClient(null);
    }
  }, []);

  const switchSession = useCallback(
    async (sessionName: string) => {
      if (!client) return false;
      try {
        await runTmux(["switch-client", "-c", client.tty, "-t", sessionName]);
        return true;
      } catch {
        return false;
      }
    },
    [client],
  );

  const jumpToPane = useCallback(
    async (sessionName: string, pane: string) => {
      if (!client) return false;
      try {
        await runTmux(["switch-client", "-c", client.tty, "-t", sessionName]);
        await runTmux(["select-pane", "-t", pane]);
        return true;
      } catch {
        return false;
      }
    },
    [client],
  );

  useEffect(() => {
    discoverClient();
    refreshSessions();
  }, [discoverClient, refreshSessions]);

  return { client, sessions, error, switchSession, jumpToPane, refreshSessions, discoverClient };
}
```

- [ ] **Step 2: Run lint**

```bash
bunx biome check --write src/tui/
```

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/useTmux.ts
git commit -m "feat: add useTmux hook for tmux client control"
```

---

### Task 13: Build TreeView, RepoNode, and WorktreeItem components

**Files:**
- Create: `src/tui/components/TreeView.tsx`
- Create: `src/tui/components/RepoNode.tsx`
- Create: `src/tui/components/WorktreeItem.tsx`

- [ ] **Step 1: Create WorktreeItem component**

```tsx
// src/tui/components/WorktreeItem.tsx
import React from "react";
import { Text, Box } from "ink";

interface Props {
  branch: string;
  hasSession: boolean;
  isAttached: boolean;
  sync: string;
  notifications: number;
  isSelected: boolean;
}

export function WorktreeItem({
  branch,
  hasSession,
  isAttached,
  sync,
  notifications,
  isSelected,
}: Props) {
  const indicator = hasSession ? "\u25CF" : "\u25CB";
  const indicatorColor = hasSession ? "green" : "gray";
  const attached = isAttached ? " *" : "";
  const notifText = notifications > 0 ? ` !${notifications}` : "";

  return (
    <Box>
      <Text color={isSelected ? "cyan" : undefined}>
        {"  "}
        <Text color={indicatorColor}>{indicator}</Text>
        {" "}
        {branch}
        <Text dimColor>{attached}</Text>
        {sync && sync !== "\u2713" ? <Text dimColor> {sync}</Text> : null}
        {notifText ? <Text color="yellow">{notifText}</Text> : null}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 2: Create RepoNode component**

```tsx
// src/tui/components/RepoNode.tsx
import React from "react";
import { Text, Box } from "ink";
import type { WorktreeInfo } from "../hooks/useRegistry";

interface Props {
  project: string;
  expanded: boolean;
  isSelected: boolean;
  worktreeCount: number;
}

export function RepoNode({ project, expanded, isSelected, worktreeCount }: Props) {
  const arrow = expanded ? "\u25BC" : "\u25B6";
  const suffix = worktreeCount === 0 ? " (no worktrees)" : "";

  return (
    <Box>
      <Text color={isSelected ? "cyan" : "yellow"} bold={isSelected}>
        {arrow} {project}
        <Text dimColor>{suffix}</Text>
      </Text>
    </Box>
  );
}
```

- [ ] **Step 3: Create TreeView component**

```tsx
// src/tui/components/TreeView.tsx
import React from "react";
import { Box } from "ink";
import type { RepoInfo } from "../hooks/useRegistry";
import type { QueueItem } from "../../services/queue-storage";
import type { TmuxSessionInfo } from "../hooks/useTmux";
import { RepoNode } from "./RepoNode";
import { WorktreeItem } from "./WorktreeItem";
import { formatSessionName } from "../../services/tmux";
import { basename } from "node:path";

export interface TreeItem {
  type: "repo" | "worktree";
  repoIndex: number;
  worktreeIndex?: number;
}

interface Props {
  repos: RepoInfo[];
  sessions: Array<{ name: string; attached: boolean }>;
  queueItems: QueueItem[];
  expandedRepos: Set<string>;
  selectedIndex: number;
  items: TreeItem[];
}

export function TreeView({
  repos,
  sessions,
  queueItems,
  expandedRepos,
  selectedIndex,
  items,
}: Props) {
  const sessionMap = new Map(sessions.map((s) => [s.name, s]));
  const notifCounts = new Map<string, number>();
  for (const item of queueItems) {
    const key = `${item.project}/${item.branch}`;
    notifCounts.set(key, (notifCounts.get(key) ?? 0) + 1);
  }

  return (
    <Box flexDirection="column">
      {items.map((item, idx) => {
        const repo = repos[item.repoIndex]!;
        if (item.type === "repo") {
          return (
            <RepoNode
              key={`repo-${repo.id}`}
              project={repo.project}
              expanded={expandedRepos.has(repo.id)}
              isSelected={idx === selectedIndex}
              worktreeCount={repo.worktrees.length}
            />
          );
        }

        const wt = repo.worktrees[item.worktreeIndex!]!;
        const sessionName = formatSessionName(basename(wt.path));
        const session = sessionMap.get(sessionName);
        const notifKey = `${repo.project}/${wt.branch}`;
        const notifications = notifCounts.get(notifKey) ?? 0;

        return (
          <WorktreeItem
            key={`wt-${repo.id}-${wt.branch}`}
            branch={wt.branch}
            hasSession={!!session}
            isAttached={session?.attached ?? false}
            sync=""
            notifications={notifications}
            isSelected={idx === selectedIndex}
          />
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 4: Run lint**

```bash
bunx biome check --write src/tui/
```

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/TreeView.tsx src/tui/components/RepoNode.tsx src/tui/components/WorktreeItem.tsx
git commit -m "feat: add TreeView, RepoNode, and WorktreeItem TUI components"
```

---

### Task 14: Build StatusBar and Modal components

**Files:**
- Create: `src/tui/components/StatusBar.tsx`
- Create: `src/tui/components/Modal.tsx`

- [ ] **Step 1: Create StatusBar**

```tsx
// src/tui/components/StatusBar.tsx
import React from "react";
import { Text, Box } from "ink";

interface Props {
  mode: "normal" | "search";
  searchQuery?: string;
}

export function StatusBar({ mode, searchQuery }: Props) {
  if (mode === "search") {
    return (
      <Box>
        <Text>/{searchQuery ?? ""}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{"─".repeat(30)}</Text>
      <Text dimColor>
        {"↑↓:navigate  enter:switch  o:open"}
      </Text>
      <Text dimColor>
        {"c:close  j:jump  /:search  q:quit"}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 2: Create Modal**

```tsx
// src/tui/components/Modal.tsx
import React, { type ReactNode } from "react";
import { Box, Text } from "ink";

interface Props {
  title: string;
  children: ReactNode;
  visible: boolean;
}

export function Modal({ title, children, visible }: Props) {
  if (!visible) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold color="cyan">
        {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 3: Run lint**

```bash
bunx biome check --write src/tui/
```

- [ ] **Step 4: Commit**

```bash
git add src/tui/components/StatusBar.tsx src/tui/components/Modal.tsx
git commit -m "feat: add StatusBar and Modal TUI components"
```

---

### Task 15: Build OpenModal component

**Files:**
- Create: `src/tui/components/OpenModal.tsx`

- [ ] **Step 1: Create OpenModal**

```tsx
// src/tui/components/OpenModal.tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./Modal";

interface Props {
  visible: boolean;
  onSubmit: (opts: { branch: string; base?: string; pr?: string; profile?: string }) => void;
  onCancel: () => void;
}

type Field = "branch" | "base" | "pr" | "profile";

const FIELDS: { key: Field; label: string; placeholder: string }[] = [
  { key: "branch", label: "Branch", placeholder: "feature/my-branch" },
  { key: "base", label: "Base", placeholder: "(optional)" },
  { key: "pr", label: "PR", placeholder: "(optional) number or URL" },
  { key: "profile", label: "Profile", placeholder: "(optional)" },
];

const EMPTY_VALUES: Record<Field, string> = {
  branch: "",
  base: "",
  pr: "",
  profile: "",
};

export function OpenModal({ visible, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<Field, string>>({ ...EMPTY_VALUES });
  const [focusIndex, setFocusIndex] = useState(0);

  useInput(
    (input, key) => {
      if (!visible) return;
      const currentField = FIELDS[focusIndex]!.key;

      if (key.escape) {
        onCancel();
        setValues({ ...EMPTY_VALUES });
        setFocusIndex(0);
        return;
      }

      if (key.backspace || key.delete) {
        setValues((prev) => ({
          ...prev,
          [currentField]: prev[currentField].slice(0, -1),
        }));
        return;
      }

      if (key.return) {
        if (focusIndex < FIELDS.length - 1) {
          setFocusIndex(focusIndex + 1);
        } else if (values.branch.trim()) {
          onSubmit({
            branch: values.branch.trim(),
            base: values.base.trim() || undefined,
            pr: values.pr.trim() || undefined,
            profile: values.profile.trim() || undefined,
          });
          setValues({ ...EMPTY_VALUES });
          setFocusIndex(0);
        }
        return;
      }

      if (key.tab) {
        setFocusIndex((focusIndex + 1) % FIELDS.length);
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        setValues((prev) => ({
          ...prev,
          [currentField]: prev[currentField] + input,
        }));
      }
    },
    { isActive: visible },
  );

  return (
    <Modal title="Open Worktree" visible={visible}>
      {FIELDS.map((field, idx) => (
        <Box key={field.key}>
          <Text color={idx === focusIndex ? "cyan" : "gray"}>
            {field.label}:{" "}
          </Text>
          <Text>
            {values[field.key] || (
              <Text dimColor>{field.placeholder}</Text>
            )}
            {idx === focusIndex ? <Text color="cyan">|</Text> : null}
          </Text>
        </Box>
      ))}
      <Text dimColor>
        Tab: next field | Enter: submit | Esc: cancel
      </Text>
    </Modal>
  );
}
```

No extra dependencies needed — text input is built with `useInput` from ink.

- [ ] **Step 2: Run lint**

```bash
bunx biome check --write src/tui/
```

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/OpenModal.tsx
git commit -m "feat: add OpenModal component for wct open from TUI"
```

---

### Task 16: Wire up the full App component

**Files:**
- Modify: `src/tui/App.tsx`

- [ ] **Step 1: Implement the full App with all hooks and components**

Replace the minimal App.tsx with the full implementation:

```tsx
// src/tui/App.tsx
import React, { useCallback, useMemo, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { useRegistry, type RepoInfo } from "./hooks/useRegistry";
import { useQueue } from "./hooks/useQueue";
import { useRefresh } from "./hooks/useRefresh";
import { useTmux } from "./hooks/useTmux";
import { TreeView, type TreeItem } from "./components/TreeView";
import { StatusBar } from "./components/StatusBar";
import { OpenModal } from "./components/OpenModal";
import { formatSessionName } from "../services/tmux";
import { basename } from "node:path";

function buildTreeItems(
  repos: RepoInfo[],
  expandedRepos: Set<string>,
): TreeItem[] {
  const items: TreeItem[] = [];
  for (let ri = 0; ri < repos.length; ri++) {
    const repo = repos[ri]!;
    items.push({ type: "repo", repoIndex: ri });
    if (expandedRepos.has(repo.id)) {
      for (let wi = 0; wi < repo.worktrees.length; wi++) {
        items.push({ type: "worktree", repoIndex: ri, worktreeIndex: wi });
      }
    }
  }
  return items;
}

export function App() {
  const { exit } = useApp();
  const { repos, loading, refresh: refreshRegistry } = useRegistry();
  const { items: queueItems, refresh: refreshQueue } = useQueue();
  const { sessions, error: tmuxError, switchSession, jumpToPane, refreshSessions, discoverClient } = useTmux();

  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [mode, setMode] = useState<"normal" | "search">("normal");
  const [searchQuery, setSearchQuery] = useState("");

  // Auto-expand all repos on first load
  React.useEffect(() => {
    if (repos.length > 0 && expandedRepos.size === 0) {
      setExpandedRepos(new Set(repos.map((r) => r.id)));
    }
  }, [repos]);

  const treeItems = useMemo(
    () => buildTreeItems(repos, expandedRepos),
    [repos, expandedRepos],
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshRegistry(), refreshQueue(), refreshSessions(), discoverClient()]);
  }, [refreshRegistry, refreshQueue, refreshSessions, discoverClient]);

  useRefresh(refreshAll);

  const toggleExpanded = useCallback(
    (repoId: string) => {
      setExpandedRepos((prev) => {
        const next = new Set(prev);
        if (next.has(repoId)) {
          next.delete(repoId);
        } else {
          next.add(repoId);
        }
        return next;
      });
    },
    [],
  );

  const handleOpen = useCallback(
    async (opts: { branch: string; base?: string; pr?: string; profile?: string }) => {
      setShowOpenModal(false);
      const args = ["open", opts.branch];
      if (opts.base) args.push("--base", opts.base);
      if (opts.pr) args.push("--pr", opts.pr);
      if (opts.profile) args.push("--profile", opts.profile);

      const proc = Bun.spawn(["wct", ...args], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
    },
    [],
  );

  useInput(
    (input, key) => {
      if (showOpenModal) return;

      if (mode === "search") {
        if (key.escape) {
          setMode("normal");
          setSearchQuery("");
        } else if (key.backspace || key.delete) {
          setSearchQuery((q) => q.slice(0, -1));
        } else if (key.return) {
          setMode("normal");
        } else if (input && !key.ctrl && !key.meta) {
          setSearchQuery((q) => q + input);
        }
        return;
      }

      if (input === "q") {
        exit();
        return;
      }

      if (input === "/") {
        setMode("search");
        setSearchQuery("");
        return;
      }

      if (input === "o") {
        setShowOpenModal(true);
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(treeItems.length - 1, i + 1));
        return;
      }

      const currentItem = treeItems[selectedIndex];
      if (!currentItem) return;

      if (key.leftArrow && currentItem.type === "repo") {
        const repo = repos[currentItem.repoIndex]!;
        if (expandedRepos.has(repo.id)) {
          toggleExpanded(repo.id);
        }
        return;
      }

      if (key.rightArrow && currentItem.type === "repo") {
        const repo = repos[currentItem.repoIndex]!;
        if (!expandedRepos.has(repo.id)) {
          toggleExpanded(repo.id);
        }
        return;
      }

      if (key.return) {
        if (currentItem.type === "repo") {
          const repo = repos[currentItem.repoIndex]!;
          toggleExpanded(repo.id);
        } else if (currentItem.type === "worktree") {
          const repo = repos[currentItem.repoIndex]!;
          const wt = repo.worktrees[currentItem.worktreeIndex!]!;
          const sessionName = formatSessionName(basename(wt.path));
          switchSession(sessionName);
        }
        return;
      }

      if (input === "c" && currentItem.type === "worktree") {
        const repo = repos[currentItem.repoIndex]!;
        const wt = repo.worktrees[currentItem.worktreeIndex!]!;
        Bun.spawn(["wct", "close", wt.branch, "--yes"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        return;
      }

      if (input === "j") {
        // Jump to first notification's pane
        if (queueItems.length > 0) {
          const item = queueItems[0]!;
          jumpToPane(item.session, item.pane);
        }
        return;
      }
    },
    { isActive: !showOpenModal },
  );

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text bold>wct</Text>
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  if (tmuxError) {
    return (
      <Box flexDirection="column">
        <Text bold>wct</Text>
        <Text color="yellow">{tmuxError}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>wct</Text>
      <Text> </Text>
      <TreeView
        repos={repos}
        sessions={sessions}
        queueItems={queueItems}
        expandedRepos={expandedRepos}
        selectedIndex={selectedIndex}
        items={treeItems}
      />
      <Text> </Text>
      <StatusBar mode={mode} searchQuery={searchQuery} />
      <OpenModal
        visible={showOpenModal}
        onSubmit={handleOpen}
        onCancel={() => setShowOpenModal(false)}
      />
    </Box>
  );
}

export function startTui() {
  render(<App />);
}
```

- [ ] **Step 2: Run lint**

```bash
bunx biome check --write src/tui/
```

- [ ] **Step 3: Test it launches and renders**

```bash
bun run src/index.ts tui
```

Expected: Shows "wct" header with tree view (empty if no repos registered), status bar with keybindings, and responds to keyboard input.

- [ ] **Step 4: Manual smoke test**

1. Register a repo: `bun run src/index.ts register`
2. Run TUI: `bun run src/index.ts tui`
3. Verify repo shows in tree with worktrees
4. Press arrow keys to navigate
5. Press `q` to quit

- [ ] **Step 5: Commit**

```bash
git add src/tui/App.tsx
git commit -m "feat: wire up full TUI App with hooks, tree view, and keybindings"
```

---

### Task 17: Add search/filter functionality

**Files:**
- Modify: `src/tui/App.tsx`

- [ ] **Step 1: Add filtering logic to App.tsx**

In the `App` component, add a `filteredRepos` memo that filters repos and worktrees by the search query, then pass `filteredRepos` to `buildTreeItems` instead of `repos`:

```typescript
const filteredRepos = useMemo(() => {
  if (!searchQuery) return repos;
  const q = searchQuery.toLowerCase();
  return repos
    .map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.filter(
        (wt) =>
          wt.branch.toLowerCase().includes(q) ||
          repo.project.toLowerCase().includes(q),
      ),
    }))
    .filter((repo) => repo.worktrees.length > 0 || repo.project.toLowerCase().includes(q));
}, [repos, searchQuery]);
```

Update `treeItems` to use `filteredRepos`. Reset `selectedIndex` to 0 when search query changes.

- [ ] **Step 2: Run lint**

```bash
bunx biome check --write src/tui/
```

- [ ] **Step 3: Test search**

Run TUI, press `/`, type a few characters, verify list filters. Press `Esc` to clear.

- [ ] **Step 4: Commit**

```bash
git add src/tui/App.tsx
git commit -m "feat: add search/filter to TUI sidebar"
```

---

### Task 18: Add worktree status enrichment to TUI

**Files:**
- Modify: `src/tui/hooks/useRegistry.ts`
- Modify: `src/tui/components/WorktreeItem.tsx`

- [ ] **Step 1: Add status fields to WorktreeInfo**

In `src/tui/hooks/useRegistry.ts`, extend `WorktreeInfo`:

```typescript
export interface WorktreeInfo {
  branch: string;
  path: string;
  isMainWorktree: boolean;
  changedFiles: number;
  sync: { ahead: number; behind: number } | null;
}
```

- [ ] **Step 2: Add status fetching to discoverWorktrees**

After parsing the worktree list, enrich each worktree with status. Use `Bun.spawn` to run git commands (same approach as the existing functions but async):

```typescript
async function getChangedCount(path: string): Promise<number> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const trimmed = text.trim();
    return trimmed ? trimmed.split("\n").length : 0;
  } catch {
    return 0;
  }
}

async function getSync(
  path: string,
  defaultBranch: string | null,
): Promise<{ ahead: number; behind: number } | null> {
  if (!defaultBranch) return null;
  try {
    const proc = Bun.spawn(
      ["git", "rev-list", "--left-right", "--count", `HEAD...${defaultBranch}`],
      { cwd: path, stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const [ahead, behind] = text.trim().split(/\s+/).map((n) => {
      const p = Number.parseInt(n, 10);
      return Number.isNaN(p) ? 0 : p;
    });
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  } catch {
    return null;
  }
}
```

Call these after discovering worktrees, passing the repo's default branch.

- [ ] **Step 3: Update WorktreeItem to show sync and changed files**

Add `changedFiles` prop to `WorktreeItem` and display it. Update the component:

```tsx
interface Props {
  branch: string;
  hasSession: boolean;
  isAttached: boolean;
  sync: string;
  changedFiles: number;
  notifications: number;
  isSelected: boolean;
}

export function WorktreeItem({
  branch,
  hasSession,
  isAttached,
  sync,
  changedFiles,
  notifications,
  isSelected,
}: Props) {
  const indicator = hasSession ? "\u25CF" : "\u25CB";
  const indicatorColor = hasSession ? "green" : "gray";
  const attached = isAttached ? " *" : "";
  const notifText = notifications > 0 ? ` !${notifications}` : "";
  const changesText = changedFiles > 0 ? ` ~${changedFiles}` : "";

  return (
    <Box>
      <Text color={isSelected ? "cyan" : undefined}>
        {"  "}
        <Text color={indicatorColor}>{indicator}</Text>
        {" "}
        {branch}
        <Text dimColor>{attached}</Text>
        {sync && sync !== "\u2713" ? <Text dimColor> {sync}</Text> : null}
        {changesText ? <Text color="blue">{changesText}</Text> : null}
        {notifText ? <Text color="yellow">{notifText}</Text> : null}
      </Text>
    </Box>
  );
}
```

Also update `TreeView.tsx` to pass `changedFiles` and `sync` (via `formatSync` from `worktree-status.ts`) to `WorktreeItem`.

- [ ] **Step 4: Run lint and test**

```bash
bunx biome check --write src/tui/
bun run src/index.ts tui
```

Verify worktrees show sync arrows and change counts.

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/useRegistry.ts src/tui/components/WorktreeItem.tsx
git commit -m "feat: add worktree status enrichment (changes, sync) to TUI"
```

---

### Task 19: Run full test suite and lint

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

```bash
bun test
```

Expected: all pass.

- [ ] **Step 2: Run lint on entire project**

```bash
bunx biome check --write
```

Fix any issues.

- [ ] **Step 3: Verify all commands work**

```bash
bun run src/index.ts --help
bun run src/index.ts list
bun run src/index.ts queue --help
bun run src/index.ts register --help
bun run src/index.ts tui --help
```

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore: fix lint and test issues"
```

---

### Task 20: End-to-end smoke test

Manual verification of the full workflow.

- [ ] **Step 1: Register a repo**

```bash
cd /path/to/some/repo
bun run /Users/dmtr/code/wct/src/index.ts register
```

- [ ] **Step 2: Launch TUI**

In a Ghostty split pane (without tmux):
```bash
bun run /Users/dmtr/code/wct/src/index.ts tui
```

- [ ] **Step 3: Verify tree view shows repos and worktrees**

- [ ] **Step 4: Test keyboard navigation**

- Arrow keys move selection
- Left/right collapse/expand repo groups
- Enter on worktree switches tmux session in adjacent pane

- [ ] **Step 5: Test open modal**

- Press `o`, fill in branch name, press Enter
- Verify worktree is created and appears in tree

- [ ] **Step 6: Test close**

- Select a worktree, press `c`
- Verify worktree is removed from tree

- [ ] **Step 7: Test jump**

- Trigger a notification (via `wct notify` in a worktree)
- Press `j` in TUI
- Verify tmux switches to the notification pane

- [ ] **Step 8: Test search**

- Press `/`, type query
- Verify tree filters
- Press `Esc` to clear

- [ ] **Step 9: Test unregister**

```bash
bun run /Users/dmtr/code/wct/src/index.ts unregister
```

Verify repo disappears from TUI on next refresh.

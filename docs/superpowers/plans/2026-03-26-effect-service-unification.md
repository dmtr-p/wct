# Effect Service Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all direct process spawning in TUI hooks and CLI commands to use Effect services via a `ManagedRuntime` bridge.

**Architecture:** Create a `ManagedRuntime` in `src/tui/runtime.ts` that provides all services the TUI needs. Extend `WorktreeService`, `GitHubService`, and `TmuxService` with new methods (and optional `cwd` on existing methods). Migrate TUI hooks and CLI commands one vertical slice at a time.

**Tech Stack:** Effect v4 (`ManagedRuntime`, `Layer`, `ServiceMap.Service`), Bun, React/Ink

---

### Task 1: ManagedRuntime setup + TmuxService extensions + useTmux migration

**Files:**
- Create: `src/tui/runtime.ts`
- Modify: `src/services/tmux.ts:25-49` (interface), `src/services/tmux.ts:409-478` (live impl)
- Modify: `src/tui/hooks/useTmux.ts` (full rewrite)
- Modify: `src/tui/types.ts:63-69` (remove `PaneInfo` — move to tmux service)
- Test: `tests/tmux.test.ts` (add parser tests)

#### Step 1: Add PaneInfo and TmuxClient types to tmux service

- [ ] **1a: Add types to `src/services/tmux.ts`**

Add after `TmuxSession` interface (line 19):

```ts
export interface TmuxPaneInfo {
  paneId: string;
  paneIndex: number;
  command: string;
  window: string;
}

export interface TmuxClient {
  tty: string;
  session: string;
}
```

- [ ] **1b: Add parser functions to `src/services/tmux.ts`**

Add after `parseSessionListOutput` (line 67):

```ts
export function parsePaneListOutput(output: string): TmuxPaneInfo[] {
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [pid, pIdx, cmd, win] = line.split("\t");
      return pid
        ? [
            {
              paneId: pid,
              paneIndex: Number(pIdx),
              command: cmd || "",
              window: win || "",
            },
          ]
        : [];
    });
}

export function parseClientListOutput(output: string): TmuxClient[] {
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [tty, session] = line.split("\t");
      return tty && session ? [{ tty, session }] : [];
    });
}
```

- [ ] **1c: Write failing parser tests**

Add to `tests/tmux.test.ts`:

```ts
import {
  parsePaneListOutput,
  parseClientListOutput,
} from "../src/services/tmux";

describe("parsePaneListOutput", () => {
  test("parses pane list output", () => {
    const output = "%0\t0\tbash\tshell\n%1\t1\tvim\teditor";
    const panes = parsePaneListOutput(output);
    expect(panes).toHaveLength(2);
    expect(panes[0]).toEqual({
      paneId: "%0",
      paneIndex: 0,
      command: "bash",
      window: "shell",
    });
    expect(panes[1]).toEqual({
      paneId: "%1",
      paneIndex: 1,
      command: "vim",
      window: "editor",
    });
  });

  test("handles empty output", () => {
    expect(parsePaneListOutput("")).toEqual([]);
  });
});

describe("parseClientListOutput", () => {
  test("parses client list output", () => {
    const output = "/dev/ttys001\tmain\n/dev/ttys002\tfeature";
    const clients = parseClientListOutput(output);
    expect(clients).toHaveLength(2);
    expect(clients[0]).toEqual({ tty: "/dev/ttys001", session: "main" });
    expect(clients[1]).toEqual({ tty: "/dev/ttys002", session: "feature" });
  });

  test("handles empty output", () => {
    expect(parseClientListOutput("")).toEqual([]);
  });

  test("skips malformed lines", () => {
    const output = "/dev/ttys001\tmain\nbadline\n/dev/ttys002\tfeature";
    const clients = parseClientListOutput(output);
    expect(clients).toHaveLength(2);
  });
});
```

- [ ] **1d: Run tests to verify they fail**

Run: `bun test tests/tmux.test.ts`
Expected: FAIL (parsePaneListOutput, parseClientListOutput not exported yet)

- [ ] **1e: Export the parsers and run tests**

Verify parsers are exported from `src/services/tmux.ts`. Run: `bun test tests/tmux.test.ts`
Expected: All tests PASS

- [ ] **1f: Commit parsers**

```bash
git add src/services/tmux.ts tests/tmux.test.ts
git commit -m "feat(tmux): add parsePaneListOutput and parseClientListOutput"
```

#### Step 2: Add new methods to TmuxService interface and implementation

- [ ] **2a: Extend TmuxService interface**

In `src/services/tmux.ts`, add to the `TmuxService` interface (after `attachSession` at line 49):

```ts
  listPanes: (
    sessionName: string,
  ) => Effect.Effect<TmuxPaneInfo[], WctError, WctServices>;
  listClients: () => Effect.Effect<TmuxClient[], WctError, WctServices>;
  switchClientToPane: (
    clientTty: string,
    target: string,
  ) => Effect.Effect<void, WctError, WctServices>;
  selectPane: (pane: string) => Effect.Effect<void, WctError, WctServices>;
  refreshClient: () => Effect.Effect<void, WctError, WctServices>;
```

- [ ] **2b: Add implementation functions**

Add before `liveTmuxService` (before line 409):

```ts
function listPanesImpl(sessionName: string) {
  return Effect.catch(
    execProcess("tmux", [
      "list-panes",
      "-s",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{pane_id}\t#{pane_index}\t#{pane_current_command}\t#{window_name}",
    ]).pipe(
      Effect.map((result) => parsePaneListOutput(result.stdout.trim())),
    ),
    () => Effect.succeed([] as TmuxPaneInfo[]),
  );
}

function listClientsImpl() {
  return Effect.catch(
    execProcess("tmux", [
      "list-clients",
      "-F",
      "#{client_tty}\t#{client_session}",
    ]).pipe(
      Effect.map((result) => parseClientListOutput(result.stdout.trim())),
    ),
    () => Effect.succeed([] as TmuxClient[]),
  );
}

function switchClientToPaneImpl(clientTty: string, target: string) {
  return execProcess("tmux", [
    "switch-client",
    "-c",
    clientTty,
    "-t",
    target,
  ]).pipe(Effect.asVoid);
}

function selectPaneImpl(pane: string) {
  return execProcess("tmux", ["select-pane", "-t", pane]).pipe(Effect.asVoid);
}

function refreshClientImpl() {
  return execProcess("tmux", ["refresh-client", "-S"]).pipe(Effect.asVoid);
}
```

- [ ] **2c: Add methods to `liveTmuxService`**

Add these entries to the `TmuxService.of({...})` object (after `attachSession`):

```ts
  listPanes: (sessionName) =>
    Effect.mapError(listPanesImpl(sessionName), (error) =>
      commandError(
        "tmux_error",
        `Failed to list panes for session '${sessionName}'`,
        error,
      ),
    ),
  listClients: () =>
    Effect.mapError(listClientsImpl(), (error) =>
      commandError("tmux_error", "Failed to list tmux clients", error),
    ),
  switchClientToPane: (clientTty, target) =>
    Effect.mapError(switchClientToPaneImpl(clientTty, target), (error) =>
      commandError(
        "tmux_error",
        `Failed to switch client to '${target}'`,
        error,
      ),
    ),
  selectPane: (pane) =>
    Effect.mapError(selectPaneImpl(pane), (error) =>
      commandError(
        "tmux_error",
        `Failed to select pane '${pane}'`,
        error,
      ),
    ),
  refreshClient: () =>
    Effect.mapError(refreshClientImpl(), (error) =>
      commandError("tmux_error", "Failed to refresh tmux client", error),
    ),
```

- [ ] **2d: Run all tests to verify nothing is broken**

Run: `bun test`
Expected: PASS

- [ ] **2e: Commit service extensions**

```bash
git add src/services/tmux.ts
git commit -m "feat(tmux): add listPanes, listClients, switchClientToPane, selectPane, refreshClient"
```

#### Step 3: Create ManagedRuntime

- [ ] **3a: Create `src/tui/runtime.ts`**

```ts
import { BunServices } from "@effect/platform-bun";
import { Layer, ManagedRuntime } from "effect";
import {
  GitHubService,
  liveGitHubService,
} from "../services/github-service";
import {
  liveQueueStorage,
  QueueStorage,
} from "../services/queue-storage";
import {
  liveRegistryService,
  RegistryService,
} from "../services/registry-service";
import {
  liveTmuxService,
  TmuxService,
} from "../services/tmux";
import {
  liveWorktreeService,
  WorktreeService,
} from "../services/worktree-service";

const tuiLayer = Layer.mergeAll(
  Layer.succeed(TmuxService, liveTmuxService),
  Layer.succeed(WorktreeService, liveWorktreeService),
  Layer.succeed(GitHubService, liveGitHubService),
  Layer.succeed(QueueStorage, liveQueueStorage),
  Layer.succeed(RegistryService, liveRegistryService),
  BunServices.layer,
);

export const tuiRuntime = ManagedRuntime.make(tuiLayer);
```

- [ ] **3b: Run `bunx biome check --write` to lint**

Run: `bunx biome check --write src/tui/runtime.ts`
Expected: Clean

- [ ] **3c: Commit runtime**

```bash
git add src/tui/runtime.ts
git commit -m "feat(tui): add ManagedRuntime for TUI service bridge"
```

#### Step 4: Migrate useTmux hook

- [ ] **4a: Rewrite `src/tui/hooks/useTmux.ts`**

```ts
import { useCallback, useEffect, useState } from "react";
import {
  TmuxService,
  type TmuxClient,
  type TmuxPaneInfo,
} from "../../services/tmux";
import { tuiRuntime } from "../runtime";

const EMPTY_PANES: Map<string, TmuxPaneInfo[]> = new Map();

export interface TmuxSessionInfo {
  name: string;
  attached: boolean;
}

export function useTmux() {
  const [client, setClient] = useState<TmuxClient | null>(null);
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [panes, setPanes] = useState<Map<string, TmuxPaneInfo[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const refreshPanes = useCallback(async (sessionList: TmuxSessionInfo[]) => {
    const paneMap = new Map<string, TmuxPaneInfo[]>();
    await Promise.all(
      sessionList.map(async (session) => {
        try {
          const result = await tuiRuntime.runPromise(
            TmuxService.use((s) => s.listPanes(session.name)),
          );
          paneMap.set(session.name, result);
        } catch {
          // Ignore pane fetch errors
        }
      }),
    );
    setPanes(paneMap);
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const result = await tuiRuntime.runPromise(
        TmuxService.use((s) => s.listSessions()),
      );
      if (!result) {
        setSessions([]);
        setPanes(EMPTY_PANES);
        return;
      }
      const parsed = result.map((s) => ({
        name: s.name,
        attached: s.attached,
      }));
      setSessions(parsed);
      await refreshPanes(parsed);
    } catch {
      setSessions([]);
      setPanes(EMPTY_PANES);
    }
  }, [refreshPanes]);

  const discoverClient = useCallback(async () => {
    try {
      const clients = await tuiRuntime.runPromise(
        TmuxService.use((s) => s.listClients()),
      );

      if (clients.length === 0) {
        setError("No tmux client found — start tmux in the other pane");
        setClient(null);
      } else if (clients.length === 1) {
        const [onlyClient] = clients;
        setClient(onlyClient ?? null);
        setError(null);
      } else {
        setError(
          `Multiple tmux clients found (${clients.length}). Multi-client support coming soon.`,
        );
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
        await tuiRuntime.runPromise(
          TmuxService.use((s) =>
            s.switchClientToPane(client.tty, `=${sessionName}`),
          ),
        );
        return true;
      } catch {
        return false;
      }
    },
    [client],
  );

  const jumpToPane = useCallback(
    async (paneId: string) => {
      if (!client) return false;
      try {
        await tuiRuntime.runPromise(
          TmuxService.use((s) => s.switchClientToPane(client.tty, paneId)),
        );
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

  return {
    client,
    sessions,
    panes,
    error,
    switchSession,
    jumpToPane,
    refreshSessions,
    discoverClient,
  };
}
```

- [ ] **4b: Update PaneInfo import in `src/tui/types.ts`**

The TUI `PaneInfo` type in `src/tui/types.ts:63-69` is now duplicated with `TmuxPaneInfo` in the service. Update `types.ts` to re-export from the service:

```ts
export type { TmuxPaneInfo as PaneInfo } from "../services/tmux";
```

Remove the old `PaneInfo` interface definition (lines 63-69).

- [ ] **4c: Update App.tsx import to use TmuxPaneInfo**

In `src/tui/App.tsx`, the `PaneInfo` import from `./types` should still work via the re-export. Verify no changes needed.

- [ ] **4d: Run tests and biome**

Run: `bun test && bunx biome check --write src/tui/`
Expected: PASS

- [ ] **4e: Commit useTmux migration**

```bash
git add src/tui/hooks/useTmux.ts src/tui/runtime.ts src/tui/types.ts src/tui/App.tsx
git commit -m "refactor(tui): migrate useTmux to TmuxService via ManagedRuntime"
```

---

### Task 2: WorktreeService extensions + useRegistry migration

**Files:**
- Modify: `src/services/worktree-service.ts:24-53` (interface), `src/services/worktree-service.ts:129-326` (live impl)
- Modify: `src/tui/hooks/useRegistry.ts` (rewrite)
- Test: `tests/worktree.test.ts` (add parser tests)

#### Step 1: Add optional cwd to existing WorktreeService methods

- [ ] **1a: Update interface**

In `src/services/worktree-service.ts`, add optional `cwd` parameter to methods that call git:

```ts
export interface WorktreeService {
  getMainRepoPath: (cwd?: string) => Effect.Effect<string | null, WctError, WctServices>;
  getCurrentBranch: (cwd?: string) => Effect.Effect<string | null, WctError, WctServices>;
  getMainWorktreePath: (cwd?: string) => Effect.Effect<string | null, WctError, WctServices>;
  isGitRepo: (cwd?: string) => Effect.Effect<boolean, WctError, WctServices>;
  listWorktrees: (cwd?: string) => Effect.Effect<Worktree[], WctError, WctServices>;
  createWorktree: (
    path: string,
    branch: string,
    useExisting: boolean,
    base?: string,
  ) => Effect.Effect<CreateWorktreeResult, WctError, WctServices>;
  branchExists: (
    branch: string,
    cwd?: string,
  ) => Effect.Effect<boolean, WctError, WctServices>;
  remoteBranchExists: (
    branch: string,
    cwd?: string,
  ) => Effect.Effect<boolean, WctError, WctServices>;
  removeWorktree: (
    path: string,
    force?: boolean,
  ) => Effect.Effect<RemoveWorktreeResult, WctError, WctServices>;
  findWorktreeByBranch: (
    branch: string,
    cwd?: string,
  ) => Effect.Effect<Worktree | null, WctError, WctServices>;
  getChangedFileCount: (cwd: string) => Effect.Effect<number, WctError, WctServices>;
  getAheadBehind: (
    cwd: string,
    ref: string,
  ) => Effect.Effect<{ ahead: number; behind: number } | null, WctError, WctServices>;
  getDefaultBranch: (cwd: string) => Effect.Effect<string | null, WctError, WctServices>;
  listBranches: (cwd: string) => Effect.Effect<string[], WctError, WctServices>;
}
```

- [ ] **1b: Update `listWorktreesImpl` to accept optional cwd**

```ts
function listWorktreesImpl(cwd?: string) {
  return execProcess("git", ["worktree", "list", "--porcelain"], cwd ? { cwd } : undefined).pipe(
    Effect.map((result) => parseWorktreeListOutput(result.stdout)),
  );
}
```

- [ ] **1c: Thread `cwd` through the live implementation**

For each method in `liveWorktreeService` that gained a `cwd` parameter, pass `cwd ? { cwd } : undefined` as options to `execProcess`/`runProcess`. For example:

`listWorktrees`:
```ts
  listWorktrees: (cwd) =>
    listWorktreesImpl(cwd).pipe(
      Effect.mapError((error) =>
        commandError("worktree_error", "Failed to list worktrees", error),
      ),
    ),
```

`getCurrentBranch`:
```ts
  getCurrentBranch: (cwd) =>
    Effect.gen(function* () {
      const branch = yield* Effect.catch(
        execProcess("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd ? { cwd } : undefined).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
        () => Effect.succeed(null),
      );
      if (!branch || branch === "HEAD") {
        return null;
      }
      return branch;
    }).pipe(
      Effect.mapError((error) =>
        commandError("worktree_error", "Failed to determine current branch", error),
      ),
    ),
```

Apply the same pattern to: `getMainRepoPath`, `getMainWorktreePath`, `isGitRepo`, `branchExists`, `remoteBranchExists`, `findWorktreeByBranch`.

- [ ] **1d: Run existing tests to verify nothing is broken**

Run: `bun test tests/worktree.test.ts`
Expected: PASS (existing callers pass no `cwd`, so behavior is unchanged)

- [ ] **1e: Commit**

```bash
git add src/services/worktree-service.ts
git commit -m "feat(worktree): add optional cwd parameter to existing methods"
```

#### Step 2: Add new WorktreeService methods and parsers

- [ ] **2a: Add parser functions**

Add to `src/services/worktree-service.ts` after `parseWorktreeListOutput`:

```ts
export function parseGitStatusCount(output: string): number {
  const trimmed = output.trim();
  return trimmed ? trimmed.split("\n").length : 0;
}

export function parseAheadBehind(
  output: string,
): { ahead: number; behind: number } | null {
  const parts = output.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const ahead = Number.parseInt(parts[0] ?? "0", 10);
  const behind = Number.parseInt(parts[1] ?? "0", 10);
  return {
    ahead: Number.isNaN(ahead) ? 0 : ahead,
    behind: Number.isNaN(behind) ? 0 : behind,
  };
}
```

- [ ] **2b: Write failing parser tests**

Add to `tests/worktree.test.ts`:

```ts
import {
  parseGitStatusCount,
  parseAheadBehind,
} from "../src/services/worktree-service";

describe("parseGitStatusCount", () => {
  test("counts lines", () => {
    expect(parseGitStatusCount(" M file1.ts\n M file2.ts\n?? file3.ts")).toBe(3);
  });

  test("returns 0 for empty output", () => {
    expect(parseGitStatusCount("")).toBe(0);
    expect(parseGitStatusCount("  ")).toBe(0);
  });
});

describe("parseAheadBehind", () => {
  test("parses ahead/behind counts", () => {
    expect(parseAheadBehind("3\t5")).toEqual({ ahead: 3, behind: 5 });
  });

  test("handles zero counts", () => {
    expect(parseAheadBehind("0\t0")).toEqual({ ahead: 0, behind: 0 });
  });

  test("returns null for invalid output", () => {
    expect(parseAheadBehind("")).toBeNull();
  });
});
```

- [ ] **2c: Run tests to verify they fail**

Run: `bun test tests/worktree.test.ts`
Expected: FAIL (parseGitStatusCount, parseAheadBehind not exported yet)

- [ ] **2d: Ensure parsers are exported and tests pass**

Run: `bun test tests/worktree.test.ts`
Expected: PASS

- [ ] **2e: Add implementation functions for new methods**

Add to `src/services/worktree-service.ts` before `liveWorktreeService`:

```ts
function getChangedFileCountImpl(cwd: string) {
  return Effect.catch(
    execProcess("git", ["status", "--porcelain"], { cwd }).pipe(
      Effect.map((result) => parseGitStatusCount(result.stdout)),
    ),
    () => Effect.succeed(0),
  );
}

function getAheadBehindImpl(cwd: string, ref: string) {
  return Effect.catch(
    execProcess(
      "git",
      ["rev-list", "--left-right", "--count", `HEAD...${ref}`],
      { cwd },
    ).pipe(Effect.map((result) => parseAheadBehind(result.stdout))),
    () => Effect.succeed(null),
  );
}

function getDefaultBranchImpl(cwd: string) {
  return Effect.gen(function* () {
    const symbolicRef = yield* Effect.catch(
      execProcess(
        "git",
        ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
        { cwd },
      ).pipe(Effect.map((result) => result.stdout.trim())),
      () => Effect.succeed(""),
    );
    if (symbolicRef) return symbolicRef;

    for (const candidate of ["main", "master"]) {
      const exists = yield* runProcess(
        "git",
        ["rev-parse", "--verify", candidate],
        { cwd },
      ).pipe(Effect.map((result) => result.success));
      if (exists) return candidate;
    }
    return null;
  });
}

function listBranchesImpl(cwd: string) {
  return Effect.catch(
    execProcess("git", ["branch", "--format=%(refname:short)"], { cwd }).pipe(
      Effect.map((result) =>
        result.stdout
          .split("\n")
          .filter(Boolean),
      ),
    ),
    () => Effect.succeed([] as string[]),
  );
}
```

- [ ] **2f: Add methods to `liveWorktreeService`**

Add inside the `WorktreeService.of({...})` object:

```ts
  getChangedFileCount: (cwd) =>
    Effect.mapError(getChangedFileCountImpl(cwd), (error) =>
      commandError("worktree_error", "Failed to get changed file count", error),
    ),
  getAheadBehind: (cwd, ref) =>
    Effect.mapError(getAheadBehindImpl(cwd, ref), (error) =>
      commandError("worktree_error", "Failed to get ahead/behind counts", error),
    ),
  getDefaultBranch: (cwd) =>
    Effect.mapError(getDefaultBranchImpl(cwd), (error) =>
      commandError("worktree_error", "Failed to determine default branch", error),
    ),
  listBranches: (cwd) =>
    Effect.mapError(listBranchesImpl(cwd), (error) =>
      commandError("worktree_error", "Failed to list branches", error),
    ),
```

- [ ] **2g: Run all tests**

Run: `bun test`
Expected: PASS

- [ ] **2h: Commit**

```bash
git add src/services/worktree-service.ts tests/worktree.test.ts
git commit -m "feat(worktree): add getChangedFileCount, getAheadBehind, getDefaultBranch, listBranches"
```

#### Step 3: Migrate useRegistry hook

- [ ] **3a: Rewrite `src/tui/hooks/useRegistry.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { useCallback, useEffect, useState } from "react";
import { RegistryService } from "../../services/registry-service";
import { WorktreeService } from "../../services/worktree-service";
import { tuiRuntime } from "../runtime";

export interface WorktreeInfo {
  branch: string;
  path: string;
  isMainWorktree: boolean;
  changedFiles: number;
  sync: { ahead: number; behind: number } | null;
}

export interface RepoInfo {
  id: string;
  repoPath: string;
  project: string;
  worktrees: WorktreeInfo[];
  profileNames: string[];
  error?: string;
}

function getProfileNames(repoPath: string): string[] {
  try {
    const paths = [join(repoPath, ".wct.yaml"), join(homedir(), ".wct.yaml")];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      const content = readFileSync(p, "utf-8");
      const parsed = Bun.YAML.parse(content);
      if (parsed?.profiles && typeof parsed.profiles === "object") {
        return Object.keys(parsed.profiles);
      }
    }
    return [];
  } catch {
    return [];
  }
}

export function useRegistry() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const items = await tuiRuntime.runPromise(
        RegistryService.use((s) => s.listRepos()),
      );
      const repoInfos: RepoInfo[] = await Promise.all(
        items.map(async (item) => {
          if (!existsSync(item.repo_path)) {
            return {
              id: item.id,
              repoPath: item.repo_path,
              project: item.project,
              worktrees: [],
              profileNames: [],
              error: "Directory not found",
            };
          }

          const [worktreeList, defaultBranch] = await Promise.all([
            tuiRuntime.runPromise(
              WorktreeService.use((s) => s.listWorktrees(item.repo_path)),
            ),
            tuiRuntime.runPromise(
              WorktreeService.use((s) => s.getDefaultBranch(item.repo_path)),
            ),
          ]);

          const profileNames = getProfileNames(item.repo_path);

          const worktrees: WorktreeInfo[] = worktreeList
            .filter((wt) => !wt.isBare)
            .map((wt, index) => ({
              branch: wt.branch,
              path: wt.path,
              isMainWorktree: index === 0,
              changedFiles: 0,
              sync: null,
            }));

          await Promise.all(
            worktrees.map(async (wt) => {
              const [changedFiles, sync] = await Promise.all([
                tuiRuntime.runPromise(
                  WorktreeService.use((s) => s.getChangedFileCount(wt.path)),
                ),
                defaultBranch
                  ? tuiRuntime.runPromise(
                      WorktreeService.use((s) =>
                        s.getAheadBehind(wt.path, defaultBranch),
                      ),
                    )
                  : Promise.resolve(null),
              ]);
              wt.changedFiles = changedFiles;
              wt.sync = sync;
            }),
          );

          return {
            id: item.id,
            repoPath: item.repo_path,
            project: item.project,
            worktrees,
            profileNames,
          };
        }),
      );
      setRepos(repoInfos);
    } catch {
      // Swallow — previous repos preserved, next poll/watch will retry
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

- [ ] **3b: Run tests and biome**

Run: `bun test && bunx biome check --write src/tui/hooks/useRegistry.ts`
Expected: PASS

- [ ] **3c: Commit**

```bash
git add src/tui/hooks/useRegistry.ts
git commit -m "refactor(tui): migrate useRegistry to WorktreeService via ManagedRuntime"
```

---

### Task 3: GitHubService extensions + useGitHub migration

**Files:**
- Modify: `src/services/github-service.ts:17-29` (interface), `src/services/github-service.ts:72-167` (live impl)
- Modify: `src/tui/hooks/useGitHub.ts` (rewrite)
- Modify: `tests/tui/use-github.test.ts` (update imports)
- Test: `tests/github.test.ts` (add parser tests if needed)

#### Step 1: Add optional cwd to existing GitHubService methods

- [ ] **1a: Update interface**

```ts
export interface GitHubService {
  isGhInstalled: () => Effect.Effect<boolean, WctError, WctServices>;
  resolvePr: (
    prNumber: number,
    cwd?: string,
  ) => Effect.Effect<PrInfo, WctError, WctServices>;
  addForkRemote: (
    remoteName: string,
    owner: string,
    repo: string,
    cwd?: string,
  ) => Effect.Effect<void, WctError, WctServices>;
  fetchBranch: (
    branch: string,
    remote?: string,
    cwd?: string,
  ) => Effect.Effect<void, WctError, WctServices>;
  listPrs: (
    cwd: string,
  ) => Effect.Effect<PrListItem[], WctError, WctServices>;
  listPrChecks: (
    cwd: string,
    prNumber: number,
  ) => Effect.Effect<PrCheckInfo[], WctError, WctServices>;
}
```

- [ ] **1b: Add new types**

Add after the existing `PrInfo` interface:

```ts
export interface PrListItem {
  number: number;
  title: string;
  state: string;
  headRefName: string;
}

export interface PrCheckInfo {
  name: string;
  state: string;
}
```

- [ ] **1c: Move parsers from useGitHub.ts to github-service.ts**

Add after types:

```ts
export function parseGhPrList(stdout: string): PrListItem[] {
  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) return [];
    return data.map((pr: Record<string, unknown>) => ({
      number: pr.number as number,
      title: pr.title as string,
      state: pr.state as string,
      headRefName: pr.headRefName as string,
    }));
  } catch {
    return [];
  }
}

export function parseGhPrChecks(stdout: string): PrCheckInfo[] {
  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) return [];
    return data.map((c: Record<string, unknown>) => ({
      name: c.name as string,
      state: c.state as string,
    }));
  } catch {
    return [];
  }
}
```

- [ ] **1d: Thread cwd through existing implementations**

For `resolvePr`, `addForkRemote`, `fetchBranch`, `detectRemoteUrl` — add optional `cwd` and pass `cwd ? { cwd } : undefined` to `execProcess`. Example for `resolvePr`:

```ts
  resolvePr: (prNumber, cwd) =>
    Effect.catch(
      Effect.gen(function* () {
        const result = yield* execProcess("gh", [
          "pr", "view", String(prNumber),
          "--json", "headRefName,isCrossRepository,headRepositoryOwner,headRepository",
        ], cwd ? { cwd } : undefined);
        // ... rest unchanged
      }),
      // ... error handling unchanged
    ),
```

- [ ] **1e: Add new method implementations**

Add before `liveGitHubService`:

```ts
function listPrsImpl(cwd: string) {
  return Effect.catch(
    execProcess(
      "gh",
      ["pr", "list", "--json", "number,title,state,headRefName", "--limit", "20"],
      { cwd },
    ).pipe(Effect.map((result) => parseGhPrList(result.stdout.trim()))),
    () => Effect.succeed([] as PrListItem[]),
  );
}

function listPrChecksImpl(cwd: string, prNumber: number) {
  return Effect.catch(
    execProcess(
      "gh",
      ["pr", "checks", String(prNumber), "--json", "name,state"],
      { cwd },
    ).pipe(Effect.map((result) => parseGhPrChecks(result.stdout.trim()))),
    () => Effect.succeed([] as PrCheckInfo[]),
  );
}
```

Add to `liveGitHubService`:

```ts
  listPrs: (cwd) =>
    Effect.mapError(listPrsImpl(cwd), (error) =>
      commandError("gh_error", "Failed to list PRs", error),
    ),
  listPrChecks: (cwd, prNumber) =>
    Effect.mapError(listPrChecksImpl(cwd, prNumber), (error) =>
      commandError("gh_error", `Failed to list checks for PR #${prNumber}`, error),
    ),
```

- [ ] **1f: Update test imports**

In `tests/tui/use-github.test.ts`, update import:

```ts
import { parseGhPrChecks, parseGhPrList } from "../../src/services/github-service";
```

- [ ] **1g: Run tests**

Run: `bun test`
Expected: PASS

- [ ] **1h: Commit**

```bash
git add src/services/github-service.ts tests/tui/use-github.test.ts
git commit -m "feat(github): add listPrs, listPrChecks, optional cwd, move parsers"
```

#### Step 2: Migrate useGitHub hook

- [ ] **2a: Rewrite `src/tui/hooks/useGitHub.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import {
  GitHubService,
  type PrCheckInfo,
  type PrListItem,
} from "../../services/github-service";
import { tuiRuntime } from "../runtime";
import type { PRInfo } from "../types";
import type { RepoInfo } from "./useRegistry";

const GITHUB_POLL_INTERVAL = 30_000;

async function fetchRepoData(repo: RepoInfo): Promise<[string, PRInfo][]> {
  const entries: [string, PRInfo][] = [];
  try {
    const prs = await tuiRuntime.runPromise(
      GitHubService.use((s) => s.listPrs(repo.repoPath)),
    );

    await Promise.all(
      prs.map(async (pr) => {
        let checks: PrCheckInfo[] = [];
        try {
          checks = await tuiRuntime.runPromise(
            GitHubService.use((s) =>
              s.listPrChecks(repo.repoPath, pr.number),
            ),
          );
        } catch {
          // Checks may not be available
        }
        const key = `${repo.project}/${pr.headRefName}`;
        entries.push([
          key,
          {
            number: pr.number,
            title: pr.title,
            state: pr.state as PRInfo["state"],
            headRefName: pr.headRefName,
            checks,
          },
        ]);
      }),
    );
  } catch {
    // gh not installed or not authenticated — silently skip
  }
  return entries;
}

export function useGitHub(repos: RepoInfo[]) {
  const [prData, setPrData] = useState<Map<string, PRInfo>>(new Map());
  const [loading, setLoading] = useState(false);
  const reposRef = useRef(repos);
  reposRef.current = repos;

  const refresh = useCallback(async () => {
    if (reposRef.current.length === 0) return;
    setLoading(true);
    try {
      const allEntries = await Promise.all(reposRef.current.map(fetchRepoData));
      setPrData(new Map(allEntries.flat()));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, GITHUB_POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  return { prData, loading, refresh };
}
```

- [ ] **2b: Run tests and biome**

Run: `bun test && bunx biome check --write src/tui/hooks/useGitHub.ts`
Expected: PASS

- [ ] **2c: Commit**

```bash
git add src/tui/hooks/useGitHub.ts
git commit -m "refactor(tui): migrate useGitHub to GitHubService via ManagedRuntime"
```

---

### Task 4: OpenModal branch listing migration

**Files:**
- Modify: `src/tui/components/OpenModal.tsx:516-531`

#### Step 1: Migrate OpenModal

- [ ] **1a: Update branch fetch in OpenModal**

Replace the `useEffect` at line 516-531 in `src/tui/components/OpenModal.tsx`:

```ts
  useEffect(() => {
    let cancelled = false;
    tuiRuntime
      .runPromise(WorktreeService.use((s) => s.listBranches(repoPath)))
      .then((result) => {
        if (!cancelled) setBranches(result);
      })
      .catch(() => {
        // Ignore branch listing errors
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);
```

Add imports at the top of `OpenModal.tsx`:

```ts
import { WorktreeService } from "../../services/worktree-service";
import { tuiRuntime } from "../runtime";
```

- [ ] **1b: Run tests and biome**

Run: `bun test && bunx biome check --write src/tui/components/OpenModal.tsx`
Expected: PASS

- [ ] **1c: Commit**

```bash
git add src/tui/components/OpenModal.tsx
git commit -m "refactor(tui): migrate OpenModal branch listing to WorktreeService"
```

---

### Task 5: Migrate useQueue to ManagedRuntime

**Files:**
- Modify: `src/tui/hooks/useQueue.ts`

#### Step 1: Update useQueue

- [ ] **1a: Rewrite `src/tui/hooks/useQueue.ts`**

```ts
import { useCallback, useEffect, useState } from "react";
import { QueueStorage, type QueueItem } from "../../services/queue-storage";
import { tuiRuntime } from "../runtime";

export function useQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await tuiRuntime.runPromise(
        QueueStorage.use((s) =>
          s.listItems({ validatePanes: true, logWarnings: false }),
        ),
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

- [ ] **1b: Run tests**

Run: `bun test`
Expected: PASS

- [ ] **1c: Commit**

```bash
git add src/tui/hooks/useQueue.ts
git commit -m "refactor(tui): migrate useQueue to ManagedRuntime"
```

---

### Task 6: CLI command cleanup (notify.ts, queue.ts)

**Files:**
- Modify: `src/commands/notify.ts:74-100, 141-148`
- Modify: `src/commands/queue.ts:63-83`

#### Step 1: Migrate notify.ts

- [ ] **1a: Replace direct tmux calls in notify.ts**

In `src/commands/notify.ts`, replace the `execProcess("tmux", ...)` calls with `TmuxService` usage.

Replace the tmux inspect block (lines 74-100) with:

```ts
    const inspectOutcome = yield* Effect.catch(
      TmuxService.use((service) =>
        service.isPaneAlive(tmuxPane).pipe(
          Effect.flatMap((alive) => {
            if (alive === false) {
              return Effect.succeed({ _tag: "MissingPane" as const });
            }
            return execProcess("tmux", [
              "display-message",
              "-p",
              "-t",
              tmuxPane,
              "#{pane_active}:#{window_visible}:#{session_attached}:#{session_name}",
            ]).pipe(
              Effect.map((result) => ({
                _tag: "Ok" as const,
                result,
              })),
            );
          }),
        ),
      ),
      (error) =>
        logger
          .warn(
            `Failed to inspect tmux pane '${tmuxPane}' for queued notification: ${getProcessErrorMessage(error)}`,
          )
          .pipe(
            Effect.as({ _tag: "InspectionFailed" as const } as
              | { _tag: "MissingPane" }
              | { _tag: "InspectionFailed" }),
          ),
    );
```

Replace the `refresh-client` call (lines 141-148) with:

```ts
    yield* Effect.catch(
      TmuxService.use((service) => service.refreshClient()),
      (error) =>
        logger.warn(
          `Failed to refresh tmux status after queueing notification session='${session}' pane='${tmuxPane}': ${getProcessErrorMessage(error)}`,
        ),
    );
```

Update imports — add `TmuxService` import, keep `execProcess` for the `display-message` call that has a unique format string.

- [ ] **1b: Run notify tests**

Run: `bun test tests/notify.test.ts`
Expected: PASS

- [ ] **1c: Commit**

```bash
git add src/commands/notify.ts
git commit -m "refactor(notify): use TmuxService instead of direct execProcess"
```

#### Step 2: Migrate queue.ts

- [ ] **2a: Replace direct tmux calls in queue.ts**

In `src/commands/queue.ts`, replace `queueInternals.jumpToItem` (lines 60-94):

```ts
export const queueInternals = {
  jumpToItem: (
    queueStorage: QueueStorageService,
    item: QueueItem,
  ): Effect.Effect<boolean, never, WctServices> =>
    Effect.catch(
      Effect.gen(function* () {
        yield* TmuxService.use((service) =>
          service.switchSession(item.session),
        );
        yield* TmuxService.use((service) =>
          service.selectPane(item.pane),
        );
        yield* queueStorage.removeItem(item.id);
        return true;
      }),
      (error) =>
        logger
          .warn(
            `Failed to jump to queue item session='${item.session}' pane='${item.pane}': ${getProcessErrorMessage(error)}`,
          )
          .pipe(Effect.as(false)),
    ),
};
```

Update imports — replace `execProcess` with `TmuxService`:

```ts
import { TmuxService } from "../services/tmux";
```

Remove the `execProcess` import if no longer used.

- [ ] **2b: Run queue tests**

Run: `bun test tests/queue-command.test.ts`
Expected: PASS

- [ ] **2c: Commit**

```bash
git add src/commands/queue.ts
git commit -m "refactor(queue): use TmuxService instead of direct execProcess"
```

---

### Task 7: Remove async wrappers and dead code

**Files:**
- Modify: `src/services/tmux.ts:480-559` (delete async wrappers)
- Modify: `src/services/queue-storage.ts:6, 153-161, 183-191` (update tmux usage)
- Modify: `tests/tmux.test.ts` (update imports)

#### Step 1: Update queue-storage.ts to use TmuxService directly

- [ ] **1a: Replace async wrapper imports in queue-storage.ts**

The `queue-storage.ts` currently imports `isPaneAlive` and `listSessions` from `./tmux` (the async wrappers). These need to be replaced with Effect-native service calls.

Replace line 6:
```ts
import { isPaneAlive, listSessions } from "./tmux";
```
With:
```ts
import { TmuxService } from "./tmux";
```

Replace the `listSessions` call in `listItems` (lines 153-161):
```ts
      const sessionList = yield* Effect.catch(
        TmuxService.use((service) => service.listSessions()),
        (error) =>
          Effect.succeed(null as import("./tmux").TmuxSession[] | null),
      );
```

Replace the `isPaneAlive` call (lines 183-191):
```ts
          const paneAlive = yield* Effect.catch(
            TmuxService.use((service) => service.isPaneAlive(row.pane)),
            () => Effect.succeed(null as boolean | null),
          );
```

- [ ] **1b: Update QueueStorageService types**

The `listItems` method's Effect now requires `WctServices` (because it calls `TmuxService.use`). Update the type:

In `src/services/queue-storage.ts`, update the `listItems` signature:

```ts
  listItems: (
    options?: ListItemsOptions,
  ) => Effect.Effect<QueueItem[], WctError, WctServices>;
```

Add import:
```ts
import type { WctServices } from "../effect/services";
```

Also update the `QueueStorage` service interface to reflect this:
```ts
export interface QueueStorageService {
  addItem: (
    item: Omit<QueueItem, "id" | "timestamp">,
  ) => Effect.Effect<QueueItem, WctError>;
  listItems: (
    options?: ListItemsOptions,
  ) => Effect.Effect<QueueItem[], WctError, WctServices>;
  removeItem: (id: string) => Effect.Effect<boolean, WctError>;
  removeItemsBySession: (session: string) => Effect.Effect<number, WctError>;
  clearAll: () => Effect.Effect<number, WctError>;
}
```

- [ ] **1c: Run tests**

Run: `bun test`
Expected: PASS

- [ ] **1d: Commit**

```bash
git add src/services/queue-storage.ts
git commit -m "refactor(queue-storage): use TmuxService directly instead of async wrappers"
```

#### Step 2: Delete async wrappers from tmux.ts

- [ ] **2a: Delete lines 480-559 in `src/services/tmux.ts`**

Remove `provideTmuxService` function and all exported async wrapper functions: `listSessions`, `isPaneAlive`, `sessionExists`, `getSessionStatus`, `createSession`, `killSession`, `getCurrentSession`, `switchSession`, `attachSession`.

Also remove the `runBunPromise` import from `../effect/runtime` and `provideWctServices` import from `../effect/services` if no longer used.

- [ ] **2b: Update test imports**

In `tests/tmux.test.ts`, remove the imports of `getCurrentSession` and `switchSession` (lines 5-8). These were the async wrappers being tested. Update imports to only use pure functions:

```ts
import {
  buildWindowsPaneCommands,
  formatSessionName,
  parseSessionListOutput,
  parsePaneListOutput,
  parseClientListOutput,
} from "../src/services/tmux";
```

Remove the `getCurrentSession` and `switchSession` test suites (lines 68-80, 527-531).

- [ ] **2c: Run all tests**

Run: `bun test`
Expected: PASS

- [ ] **2d: Run biome on all changed files**

Run: `bunx biome check --write src/services/tmux.ts src/services/queue-storage.ts tests/tmux.test.ts`
Expected: Clean

- [ ] **2e: Commit**

```bash
git add src/services/tmux.ts src/services/queue-storage.ts tests/tmux.test.ts
git commit -m "refactor(tmux): remove async wrapper functions, use service directly"
```

---

### Task 8: Final verification

**Files:** None (verification only)

- [ ] **1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **2: Run biome on entire project**

Run: `bunx biome check --write`
Expected: Clean

- [ ] **3: Verify no remaining direct Bun.spawn in TUI**

Run: `grep -r "Bun.spawn" src/tui/`
Expected: Only in `App.tsx` for `wct open/up/close` and `gh pr view --web` (write operations, intentionally kept)

- [ ] **4: Verify no remaining async wrapper imports**

Run: `grep -rn "from.*tmux.*import.*listSessions\|from.*tmux.*import.*isPaneAlive\|from.*tmux.*import.*sessionExists\|from.*tmux.*import.*getSessionStatus\|from.*tmux.*import.*createSession\|from.*tmux.*import.*killSession\|from.*tmux.*import.*getCurrentSession\|from.*tmux.*import.*switchSession\b\|from.*tmux.*import.*attachSession" src/`
Expected: No matches (all async wrapper imports removed)

- [ ] **5: Commit any remaining fixes if needed**

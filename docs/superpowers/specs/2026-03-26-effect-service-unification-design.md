# Effect Service Unification

Migrate all direct process spawning (`Bun.spawn`, raw `execProcess`) to use Effect services, with a `ManagedRuntime` bridge for the TUI.

## Motivation

- **Testability**: parsers and service methods can be unit-tested without spawning real processes
- **Consistency**: TUI hooks currently reimplement what CLI services already do (git worktree listing, tmux session queries, gh PR fetching)
- **Extensibility**: add caching, retries, or logging in one place and have everything benefit

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Effect-to-React bridge | `ManagedRuntime` (built into `effect`) | No new dependencies; proper service wiring and lifecycle |
| New methods vs new services | Extend existing services | Operations belong with their service (git with WorktreeService, etc.). Split later if interfaces grow too large |
| TUI write operations (`wct open/up/close`) | Keep shelling out to `wct` binary | Complex multi-step orchestrations; subprocess reuse is simplest |
| Migration strategy | Hook-by-hook vertical slices | Each slice is independently reviewable and testable |
| Existing method signatures | Add optional `cwd` parameter | TUI queries multiple repos; CLI callers omit it for unchanged behavior |

## Architecture

### ManagedRuntime Setup

New file `src/tui/runtime.ts`:

```ts
import { ManagedRuntime, Layer } from "effect";

const tuiLayer = Layer.mergeAll(
  Layer.succeed(TmuxService, liveTmuxService),
  Layer.succeed(WorktreeService, liveWorktreeService),
  Layer.succeed(GitHubService, liveGitHubService),
  Layer.succeed(QueueStorage, liveQueueStorage),
  Layer.succeed(RegistryService, liveRegistryService),
);

export const tuiRuntime = ManagedRuntime.make(tuiLayer);
```

- Created once at module scope (lazy — services built on first use)
- `tuiRuntime.dispose()` called in `App.tsx` unmount cleanup
- All TUI hooks call `tuiRuntime.runPromise(Service.use(...))`

### Service Extensions

**WorktreeService** (4 new methods + optional `cwd` on existing methods):

| Method | Git command | Returns |
|--------|-----------|---------|
| `getChangedFileCount(path)` | `git status --porcelain` | `number` |
| `getAheadBehind(path, ref)` | `git rev-list --left-right --count` | `{ ahead: number; behind: number } \| null` |
| `getDefaultBranch(repoPath)` | `git symbolic-ref refs/remotes/origin/HEAD` + main/master fallback | `string \| null` |
| `listBranches(repoPath)` | `git branch --format=%(refname:short)` | `string[]` |

Existing methods (`listWorktrees`, `getMainRepoPath`, `getCurrentBranch`, `isGitRepo`, `branchExists`, `remoteBranchExists`, `findWorktreeByBranch`, `getMainWorktreePath`, `createWorktree`, `removeWorktree`) get an optional `cwd?: string` parameter passed through to `execProcess`.

**GitHubService** (2 new methods + optional `cwd` on existing methods):

| Method | Command | Returns |
|--------|---------|---------|
| `listPrs(cwd)` | `gh pr list --json number,title,state,headRefName` | `PrListItem[]` |
| `listPrChecks(cwd, prNumber)` | `gh pr checks --json name,state` | `CheckInfo[]` |

Existing methods (`resolvePr`, `fetchBranch`, `addForkRemote`, `isGhInstalled`) get optional `cwd`.

**TmuxService** (3 new methods):

| Method | Command | Returns |
|--------|---------|---------|
| `listPanes(sessionName)` | `tmux list-panes -s` | `PaneInfo[]` |
| `listClients()` | `tmux list-clients` | `TmuxClient[]` |
| `selectPane(pane)` | `tmux select-pane -t` | `void` |
| `refreshClient()` | `tmux refresh-client -S` | `void` |

### Hook Migrations

**`useTmux.ts`**: Replace `runTmux()` helper with `tuiRuntime.runPromise(TmuxService.use(...))` calls. Delete the local `runTmux` function.

**`useRegistry.ts`**: Replace `getChangedCount()`, `getSync()`, `getDefaultBranch()`, `discoverWorktrees()` with `WorktreeService` calls via `tuiRuntime`. Keep `getProfileNames()` as-is (filesystem read).

**`useGitHub.ts`**: Replace `runGh()` helper with `GitHubService` calls via `tuiRuntime`. Move `parseGhPrList` and `parseGhPrChecks` to `github-service.ts`.

**`OpenModal.tsx`**: Replace `Bun.spawn(["git", "branch", ...])` with `WorktreeService.use(s => s.listBranches(repoPath))`.

**`useQueue.ts`** and **`useRegistry.ts`** (existing Effect calls): Switch from `Effect.runPromise(liveService.method())` to `tuiRuntime.runPromise(Service.use(...))`.

### CLI Command Cleanup

**`commands/notify.ts`**: Replace direct `execProcess("tmux", ...)` with `TmuxService` methods (`isPaneAlive`, `refreshClient`).

**`commands/queue.ts`**: Replace direct `execProcess("tmux", ["switch-client", ...])` and `execProcess("tmux", ["select-pane", ...])` with `TmuxService.switchSession()` and `TmuxService.selectPane()`.

### Dead Code Removal

**`tmux.ts` lines 486-559**: Delete all async wrapper functions (`listSessions`, `isPaneAlive`, `sessionExists`, `getSessionStatus`, `createSession`, `killSession`, `getCurrentSession`, `switchSession`, `attachSession`) and the `provideTmuxService` helper.

**`queue-storage.ts`**: Update imports — switch from async wrapper imports (`isPaneAlive`, `listSessions`) to using `TmuxService` directly via Effect.

### Parsing Functions

Move and extract parsers as exported pure functions (unit-testable without process spawning):

| Parser | Location | Purpose |
|--------|----------|---------|
| `parseWorktreeListOutput` | `worktree-service.ts` (exists) | Parse `git worktree list --porcelain` |
| `parseSessionListOutput` | `tmux.ts` (exists) | Parse `tmux list-sessions` |
| `parseGitStatusCount` | `worktree-service.ts` (new) | Count lines from `git status --porcelain` |
| `parseAheadBehind` | `worktree-service.ts` (new) | Parse `git rev-list --left-right --count` |
| `parsePaneList` | `tmux.ts` (new) | Parse `tmux list-panes` |
| `parseClientList` | `tmux.ts` (new) | Parse `tmux list-clients` |
| `parseGhPrList` | `github-service.ts` (move from `useGitHub.ts`) | Parse `gh pr list --json` |
| `parseGhPrChecks` | `github-service.ts` (move from `useGitHub.ts`) | Parse `gh pr checks --json` |

## Implementation Order

Each step is a vertical slice (one PR):

1. **ManagedRuntime + useTmux** — setup `src/tui/runtime.ts`, add `listPanes`/`listClients` to `TmuxService`, migrate `useTmux.ts`
2. **useRegistry** — add `getChangedFileCount`/`getAheadBehind`/`getDefaultBranch` to `WorktreeService`, add optional `cwd` to existing methods, migrate `useRegistry.ts`
3. **useGitHub** — add `listPrs`/`listPrChecks` to `GitHubService`, move parsers, migrate `useGitHub.ts`
4. **OpenModal** — add `listBranches` to `WorktreeService`, migrate `OpenModal.tsx`
5. **CLI stragglers** — migrate `notify.ts` and `queue.ts` to use `TmuxService`, add `selectPane`/`refreshClient`
6. **Cleanup** — remove tmux.ts async wrappers, update `queue-storage.ts` imports, remove dead code

## Out of Scope

- Extracting a `ProcessRunner` service for full mockability (future work)
- Migrating TUI write operations (`wct open/up/close`) away from subprocess spawning
- Adding caching or retry logic to services (enabled by this refactor, but not included)

# TUI Sidebar Design

Interactive terminal UI sidebar for managing worktrees across repos, built with Ink/React, running in a terminal split pane alongside a tmux client.

## Overview

`wct tui` launches a persistent sidebar that shows all registered repos and their worktrees in a collapsible tree view. It controls the tmux client in an adjacent terminal pane — switching sessions, jumping to notification panes, opening/closing worktrees — replacing the existing interactive queue, tmux status bar notifications, and C-q keybinding.

The TUI is terminal-agnostic — it works in any terminal emulator with split pane support (Ghostty, iTerm2, WezTerm, kitty). It communicates with tmux entirely via CLI commands.

## Architecture

### Process Model

- **Single process**: `wct tui` is an Effect CLI subcommand that lazy-imports Ink/React (`await import("../tui/App.tsx")`) so the dependency is only loaded for this command
- **Alternate screen**: TUI enters the terminal's alternate screen buffer (`\x1b[?1049h\x1b[H`) on startup and restores the main screen (`\x1b[?1049l`) on exit, keeping the user's scrollback clean
- **Two terminal panes**: TUI in one split, tmux client in the other
- **tmux control**: On startup, TUI runs `tmux list-clients` and expects exactly one client. If multiple clients exist, it errors with a message to specify a target (future: `--target` flag). It stores the client TTY and uses `tmux switch-client -t <tty>` to target it.

### Data Layer

**Unified database** at `~/.wct/wct.db` (SQLite) replaces the existing `~/.wct/queue.db`.

Registry table (repo list only — worktrees are discovered via git):

```sql
CREATE TABLE registry (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Queue table (unchanged from existing schema, moved to new DB):

```sql
CREATE TABLE queue (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  session TEXT NOT NULL,
  pane TEXT NOT NULL UNIQUE,
  timestamp INTEGER NOT NULL
);
```

On first run, if `wct.db` does not exist and `queue.db` does, delete `queue.db`. No migration — pending queue items in the old DB are discarded.

### Refresh Strategy (Hybrid)

- **Slow poll (5s)**: Query registry + git worktree list + queue on interval
- **Instant refresh**: `fs.watch` on the `~/.wct/` directory triggers immediate re-query when any wct command writes to the DB. Watching the directory rather than the DB file directly ensures WAL-mode writes are detected.
- **Live status enrichment**: On each refresh, for each worktree:
  - Check tmux session existence and attachment status
  - Count changed files (`git status --porcelain`)
  - Calculate ahead/behind vs default branch (`git rev-list`)
  - Count pending notifications from queue table

### Worktree Discovery

The registry stores **repos**, not worktrees. On each refresh:

1. Read registered repos from `registry` table
2. For each repo, run `git worktree list` to discover all actual worktrees
3. This catches worktrees created outside of wct
4. Enrich with live status (tmux, changes, sync, notifications)
5. Load profile names from repo's `.wct.yaml` (or global `~/.wct.yaml`) for the Open Modal

## UI Design

### Layout: Tree View

```
wct

▼ my-api
  ● main         *
  ○ feat/auth    ↑2
  ○ fix/cors     !3

▼ web-app
  ● main         *
  ○ redesign     ↑1↓3

▶ data-pipeline  (no worktrees)

───────────────────
↑↓:navigate  enter:switch  o:open
c:close  j:jump  /:search  q:quit
```

- `▼`/`▶` — collapsible repo groups (toggle with Enter on repo header or left/right arrows)
- `●` — active tmux session, `○` — no session
- `*` — attached session
- `↑N`/`↓N` — commits ahead/behind default branch
- `!N` — pending notification count

### Selection Indicator

Selected items are highlighted with:
- `❯` cursor prefix
- Cyan color + bold + inverse (reverse video) on the item text

This makes the active selection clearly visible at a glance.

### Keybindings

| Key | Action |
|-----|--------|
| `↑`/`↓` | Navigate items |
| `←`/`→` | Collapse/expand repo group |
| `Enter` | Switch tmux to selected worktree's session (if session exists) or run `wct up` (if no session) |
| `o` | Open modal: create new worktree |
| `c` | Close selected worktree (switches to another session first if closing the active one) |
| `j` | Jump to pane with pending notification |
| `/` | Filter/search worktrees |
| `q` | Quit TUI |

### Open Modal

Pressing `o` shows a centered modal overlay with:

**Text fields:**
- Branch name (required)
- Base branch (pre-filled with selected worktree's branch)
- PR number or URL
- Profile name (only shown if profiles exist in repo's `.wct.yaml`)
- Prompt (multiline textarea — Enter adds newline, Tab advances to next field)

**Toggle fields:**
- Existing branch `[ ]`/`[x]`
- No IDE `[ ]`/`[x]`
- No attach `[ ]`/`[x]`

**Submit button** at the bottom — highlighted green when focused.

**Navigation:** Tab/↑↓ to move between fields, Space to toggle checkboxes, Ctrl+S to submit from any field, Esc to cancel.

Runs `wct open` in the background with all selected flags. TUI refreshes when DB changes.

## Component Tree

```
App
├── TreeView
│   ├── RepoNode (collapsible)
│   │   ├── WorktreeItem (selectable, shows status)
│   │   └── WorktreeItem
│   └── RepoNode
│       └── WorktreeItem
├── OpenModal
├── StatusBar
└── Modal (generic wrapper)
```

## File Structure

```
src/
├── tui/
│   ├── App.tsx
│   ├── components/
│   │   ├── TreeView.tsx
│   │   ├── RepoNode.tsx
│   │   ├── WorktreeItem.tsx
│   │   ├── OpenModal.tsx
│   │   ├── StatusBar.tsx
│   │   └── Modal.tsx
│   └── hooks/
│       ├── useRegistry.ts
│       ├── useQueue.ts
│       ├── useRefresh.ts
│       └── useTmux.ts
├── commands/
│   └── tui.ts
├── services/
│   ├── registry-service.ts
│   └── worktree-status.ts   # Extracted from list.ts: getChangedFiles, getAheadBehind, getDefaultBranch
```

## Changes to Existing Code

### Removals

- **`wct queue --interactive`** — replaced by TUI
- **C-q tmux keybinding** registration in tmux session setup
- **Notification count in tmux status bar** (`--count` flag usage in status bar config)

### Modifications

- **`queue-storage.ts`** — change DB path from `~/.wct/queue.db` to `~/.wct/wct.db`; delete old `queue.db` if `wct.db` doesn't exist
- **`tmux.ts`** — remove C-q keybinding setup and status bar notification count integration
- **`queue.ts`** — remove `--interactive` mode
- **`list.ts`** — extract status-checking logic (changed files, ahead/behind, default branch detection) into `worktree-status.ts` service so both `wct list` and the TUI share it
- **`open.ts`** — ensure repo is registered in registry on open
- **`init.ts`** — register repo in registry
- **`CLAUDE.md`** — document Ink/React dependencies, update runtime dependency policy to note this deliberate exception, document TUI architecture and file structure

### New Commands

- **`wct register [path]`** — register a repo in the registry (defaults to current directory). Auto-detects project name from `.wct.yaml`.
- **`wct unregister [path]`** — remove a repo from the registry.

### Preserved

- `wct queue --jump`, `--dismiss`, `--clear` (used by TUI internally)
- `wct notify` (writes to queue table, unchanged)
- All other commands unchanged

## New Dependencies

This is a deliberate exception to the project's runtime dependency constraint (documented in CLAUDE.md). These deps are only loaded when `wct tui` is invoked.

- `ink` (runtime)
- `react` (runtime, peer dep of ink)
- `@types/react` (dev)

## Error Handling

- **No tmux client**: TUI shows "No tmux client found" message, polls until one appears
- **Multiple tmux clients**: TUI errors with message to specify target (future: `--target` flag)
- **Repo directory missing**: Registry sync detects missing path, marks repo as unavailable (greyed out)
- **Worktree deleted outside wct**: Next git sync cycle removes it from the list
- **TUI crash**: No state corruption — registry is a repo list, worktrees are git-derived, queue is persistent

## Testing

- **Unit tests**: Registry service CRUD, worktree discovery/sync logic, status enrichment (worktree-status service)
- **Component tests**: Ink `render()` test utility — tree view expansion/collapse, keyboard navigation, modal open/close
- **tmux control**: Thin shell-out wrappers, tested manually

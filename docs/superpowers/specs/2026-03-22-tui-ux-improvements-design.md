# TUI UX Improvements Design

## Overview

Improve the `wct tui` experience to be more responsive and show more information. The approach is incremental enhancement with a light state machine refactor — layer features onto the existing architecture without a full rewrite.

## 1. Mode System & Context-Aware Status Bar

### Problem

App.tsx manages mode with a loose string (`"normal" | "search"`) and scattered `if` checks. The status bar shows static keybinding hints regardless of context.

### Design

Extract an explicit mode enum that drives both keyboard dispatch and the status bar. Rename `"normal"` to `Navigate` for clarity.

**Modes:**

| Mode | Description |
|------|-------------|
| `Navigate` | Default tree browsing (replaces `"normal"`) |
| `Search` | Filter mode with `/query` |
| `OpenModal` | Three sub-modes: NewBranch, FromPR, ExistingBranch |
| `Expanded` | Worktree detail view |

**Mode transitions:**

| From | Trigger | To |
|------|---------|-----|
| Navigate | `/` | Search |
| Navigate | `o` | OpenModal (mode selector) |
| Navigate | `→` on worktree item | Expanded |
| Search | `esc` | Navigate (clears filter) |
| Search | `enter` | Navigate (keeps current filter results, exits search input) |
| OpenModal | `esc` | Navigate |
| OpenModal | submit | Navigate (triggers action) |
| Expanded | `←` or `esc` | Navigate |
| Expanded | `o` | OpenModal (mode selector) |
| Expanded | `/` | Search (collapses expanded view) |

Note: `space` works in both Navigate and Expanded modes (switches/creates tmux session for the selected worktree). `o` is available from Expanded mode for convenience.

**Keyboard dispatch:** A single `useInput` handler checks the current mode and delegates to mode-specific handlers. No scattered conditionals.

**`enter` key behavior by mode:**
- **Navigate:** `→` expands worktree, `enter` is not used (use `space` to switch). `enter` on a repo node toggles expand/collapse.
- **Search:** Exits search mode, keeps filtered results visible.
- **OpenModal:** Confirms selection (mode selector) or submits form.
- **Expanded:** Context action on selected detail row (jump to notification pane, open PR in browser, etc.).

**Status bar:** Two lines pinned to the bottom (plus a separator line above), content driven by current mode:

- **Navigate:** `↑↓:navigate  ←→:expand/collapse  space:switch  o:open  c:close  j:jump  /:search  q:quit`
- **Search:** `type to filter  esc:cancel  enter:done`
- **OpenModal (mode selector):** `↑↓:select  enter:confirm  esc:cancel`
- **OpenModal (form):** `tab:next  shift+tab:prev  ctrl+s:submit  esc:cancel`
- **OpenModal (PR/branch list):** `↑↓:select  type:filter  tab:next field  ctrl+s:submit  esc:cancel`
- **Expanded:** `↑↓:navigate  enter:action  ←:collapse  space:switch  o:open  q:quit`

## 2. Inline Optimistic Updates & Action Progress

### Problem

Actions like opening/closing worktrees happen in the background with no visual feedback until the next refresh cycle.

### Design

A `pendingActions` map in App.tsx tracks in-flight operations. Keys use `${project}/${branch}` format to avoid collisions across repos:

```
Map<`${project}/${branch}`, { type: "opening" | "closing" | "starting", branch: string, project: string }>
```

| Action | Optimistic UI | On completion | On failure |
|--------|--------------|---------------|------------|
| Open (new worktree) | Insert phantom worktree item at end of the selected repo's worktree list, with "opening..." in yellow italic | Replace with real worktree data on next refresh | Remove phantom after 5s, show dim red error text inline |
| Close | Dim the item (`dimColor` on all text), show "closing..." | Remove item on next refresh | Restore normal appearance after 5s |
| Space (start session) | Show "starting..." next to `○` indicator | `○` becomes `●` on next refresh | Clear status text after 5s |

No toasts or notification areas — all feedback is inline on the affected item.

Pending state is cleared automatically when the next refresh cycle detects the actual state change (worktree appears/disappears in `git worktree list`, session appears in `tmux list-sessions`). The 5s error timeout is a fallback for when the process fails.

## 3. Expandable Worktree Items

### Problem

The tree view shows a single line per worktree with minimal status indicators. Users need to leave the TUI to check PR status, GitHub checks, tmux pane layout, or notification details.

### Design

When a worktree is selected and the user presses `→`, it expands to show detail rows beneath it (same pattern as repos expanding to show worktrees).

**Data model:** Detail rows are inserted into the existing flat `TreeItem[]` list as additional entries with a new `type: "detail"` variant. This keeps the single `selectedIndex` navigation model intact. Each detail row has a `detailKind` field (`"notification" | "pr" | "check" | "pane-header" | "pane"`) and an `action` callback for `enter`.

Only one worktree can be expanded at a time. Expanding another collapses the previous.

**Expanded content order (notifications first if any):**

```
▼ wct
    ● main         ✓
  ▼ ● improve-tui  ↑2 ~5 *
      Notifications
        !  build complete (pane 2)
        !  tests passed (pane 3)
      PR #34: feat: add TUI sidebar
        ✓ build  ✓ lint  ✗ test  ◌ deploy
      Panes
        1: nvim (window: editor)
        2: bun test --watch (window: editor)
```

**Indentation:** Detail rows use 6-space indent from the worktree's indent level. Section headers (Notifications, Panes) are at the detail indent level; individual items are indented 2 more spaces.

**Sections:**

| Section | Source | Display | `enter` action |
|---------|--------|---------|----------------|
| Notifications | Existing queue data | Message text + pane reference | Jump to pane (switch session + select pane) |
| PR info | `gh pr list --head <branch>` via cached GitHub data | PR number, title, state | Open PR in browser (`gh pr view --web`) |
| Checks | `gh pr checks <number>` via cached GitHub data | Status icon (✓ ✗ ◌) + check name | No action (informational) |
| Panes | `tmux list-panes -t <session> -F '#{pane_index}:#{pane_current_command}:#{window_name}'` | Pane index, running command, window name | Jump to pane |

Sections are omitted when empty (e.g., no notifications → no Notifications header).

**Navigation:** When expanded, `↑↓` moves through detail rows (they're part of the flat list). `←` or `esc` collapses back to Navigate mode. `space` still switches to the expanded worktree's tmux session.

**Data:** PR and checks come from background GitHub fetch (30-60s cadence). Tmux panes refresh with the regular 5s poll. No extra fetch on expand — uses cached data.

## 4. Background GitHub Data Fetching

### Problem

GitHub data (PRs, checks) is not currently available in the TUI. It needs to be fetched without blocking the UI.

### Design

New `useGitHub` hook that fetches PR and check data for all registered repos on a slower cadence.

**Fetch strategy:**
- Initial fetch on TUI startup
- Re-fetch every 60 seconds via its own `setInterval`, independent of the 5s `useRefresh` cycle
- Uses `gh pr list --json number,title,state,headRefName --limit 20` and `gh pr checks <number> --json name,state` via `Bun.spawn`
- Commands run with `cwd: repoPath` so `gh` resolves the correct GitHub remote automatically
- Repos are fetched in parallel (`Promise.all`) to minimize total latency
- Data cached in React state, keyed by `${project}/${branch}`
- Errors are silently ignored (GitHub data is supplementary — if `gh` is not installed or not authenticated, expanded views simply omit PR/checks sections)

**useTmux extension:** The existing `useTmux` hook is extended to also fetch per-session pane data via `tmux list-panes -t <session> -F '#{pane_index}:#{pane_current_command}:#{window_name}'`. This runs on the same 5s cadence as session data.

**Data structure:**

```typescript
type PRInfo = {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  checks: Array<{ name: string; state: "SUCCESS" | "FAILURE" | "PENDING" }>;
};

type PaneInfo = {
  index: number;
  command: string;
  window: string;
};

// GitHub: Map<`${project}/${branch}`, PRInfo>
// Panes: Map<sessionName, PaneInfo[]>
```

## 5. Open Modal Redesign

### Problem

The current modal overloads a single form for branch creation, PR opening, and existing branch checkout. PR number conflicts with branch/base fields.

### Design

Three-path flow: mode selector → mode-specific form.

**Repo scoping:** The modal operates on the repo of the currently selected tree item. If a repo node is selected, that repo is used. If a worktree is selected, its parent repo is used. The modal title shows the repo name: `Open Worktree (wct)`.

**Step 1 — Mode selection** (when user presses `o`):

```
[ New Branch      ]
[ Open from PR    ]
[ Existing Branch ]
```

Bracket-style list with blinking cursor on the selected option. `↑↓` to select, `enter` to confirm, `esc` to cancel.

**Step 2 — Mode-specific forms:**

**New Branch:**
- Branch: text input (brackets, blinking cursor)
- Base: text input (pre-filled from selected worktree's branch, fallback to default branch)
- Profile: text input (only shown if profiles exist in config — preserving existing behavior)
- Prompt: textarea (horizontal lines, not brackets)
- Toggles: ☐ No IDE, ☐ No Attach

**Open from PR:**
- PR: scrollable list from cached GitHub data for the selected repo (plain rows with `▸` cursor, no brackets). Type to filter. Shows only open PRs.
- Profile: text input (only shown if profiles exist)
- Prompt: textarea (horizontal lines)
- Toggles: ☐ No IDE, ☐ No Attach

**Existing Branch:**
- Branch: scrollable list from `git branch -r` run with `cwd: repoPath` (plain rows with `▸` cursor, no brackets). Type to filter. Strips `origin/` prefix for display.
- Profile: text input (only shown if profiles exist)
- Prompt: textarea (horizontal lines)
- Toggles: ☐ No IDE, ☐ No Attach
- No Base field (not needed for existing branches)

**Scrollable list component:** Lists show a visible window of up to 10 items. When the selection moves beyond the window, it scrolls. A scroll indicator (`▲`/`▼`) appears when there are items above/below the window. Typing characters filters the list in real-time; backspace removes filter characters.

### Focus indicators

- **Text inputs:** Cyan brackets `[ value▎ ]` with blinking cursor for focused field. Dim gray brackets for unfocused.
- **Lists:** Plain rows, `▸` cursor on selected item, no brackets.
- **Textarea (prompt):** Horizontal lines top and bottom (Claude Code style), not brackets.
- **Labels:** Bold + accent color when focused, dim when unfocused.
- **Blinking cursor implementation:** Use a `setInterval` toggle (500ms) flipping a boolean that controls cursor character visibility, since Ink does not expose ANSI blink natively.

### Cursor character

Use `❯` (U+276F) consistently for both the tree view selection cursor and modal list cursors, matching the existing codebase convention.

## 6. Space to Switch/Create Session

### Problem

`enter` switches to a tmux session, but if no session exists the user must use a separate flow. There's no single-key "just get me there" action.

### Design

`space` becomes the primary "switch" key:
- If worktree has an active tmux session → switch to it (`tmux switch-client`)
- If worktree exists but has no session → run `wct up` to create session, then switch (with "starting..." optimistic indicator)
- If no tmux client is detected (TUI running outside tmux) → no-op (existing error screen already handles this case)

`enter` remains for context-sensitive actions (expand worktree in Navigate, jump to pane in Expanded, confirm in modal, etc.).

## 7. Visual Style

### ANSI colors

All colors use standard ANSI names (cyan, dim, bold, etc.) so terminal themes control the palette. No hardcoded hex values in the Ink components.

**Color semantics:**
- **Cyan:** Active/focused elements (selected item, focused field, cursor)
- **Bold:** Emphasis (selected items, focused labels, repo names)
- **Dim/dimColor:** Inactive/unfocused elements, pending close items
- **Yellow:** Warnings, pending states, changed file counts (changing from current blue to yellow for consistency with "attention needed" semantics)
- **Red:** Errors, failed checks, notifications
- **Green:** Success, passed checks, active sessions (`●`)

## Component Changes Summary

| Component | Changes |
|-----------|---------|
| `App.tsx` | Mode enum + transitions, keyboard dispatch refactor, pendingActions state, expanded worktree state |
| `TreeView.tsx` | Render expanded worktree detail rows (as TreeItem entries), phantom items for optimistic updates |
| `WorktreeItem.tsx` | Support expanded state indicator (`▼`/`▶`), inline status text for pending actions |
| `StatusBar.tsx` | Accept mode prop, render context-aware 2-line hints per mode |
| `OpenModal.tsx` | Complete redesign: mode selector + three form variants with scrollable lists |
| `Modal.tsx` | Minor updates to support new content |
| `RepoNode.tsx` | No changes |
| **New:** `useGitHub.ts` | Background GitHub data fetching hook (own 60s setInterval) |
| **New:** `ExpandedView.tsx` | Notifications, PR/checks, panes detail row components |
| **New:** `ScrollableList.tsx` | Reusable scrollable filterable list component for modal |

## New Hooks

| Hook | Purpose |
|------|---------|
| `useGitHub` | Fetch PR list and check status per repo on 60s cadence via `gh` CLI. Own `setInterval`, independent of `useRefresh`. |

## Modified Hooks

| Hook | Changes |
|------|---------|
| `useTmux` | Extended to also fetch per-session pane data via `tmux list-panes` on the existing 5s cadence |

## Data Flow

```
useRegistry (5s) ──→ repos + worktrees ──→ TreeView
useQueue (5s) ──────→ notifications ─────→ TreeView (counts) + ExpandedView (details)
useTmux (5s) ──────→ sessions/panes ────→ TreeView (indicators) + ExpandedView (pane list)
useGitHub (60s) ───→ PRs + checks ──────→ ExpandedView (PR info, check status)
                                          OpenModal (PR list for "Open from PR")
useRefresh ────────→ orchestrates useRegistry, useQueue, useTmux via poll + fs.watch
useGitHub ─────────→ independent 60s setInterval (not part of useRefresh)
```

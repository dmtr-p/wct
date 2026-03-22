# TUI UX Improvements Design

## Overview

Improve the `wct tui` experience to be more responsive and show more information. The approach is incremental enhancement with a light state machine refactor — layer features onto the existing architecture without a full rewrite.

## 1. Mode System & Context-Aware Status Bar

### Problem

App.tsx manages mode with a loose string and scattered `if` checks. The status bar shows static keybinding hints regardless of context.

### Design

Extract an explicit mode enum that drives both keyboard dispatch and the status bar.

**Modes:**

| Mode | Description |
|------|-------------|
| `Navigate` | Default tree browsing |
| `Search` | Filter mode with `/query` |
| `OpenModal` | Three sub-modes: NewBranch, FromPR, ExistingBranch |
| `Expanded` | Worktree detail view |

**Keyboard dispatch:** A single `useInput` handler checks the current mode and delegates to mode-specific handlers. No scattered conditionals.

**Status bar:** Two lines pinned to the bottom, content driven by current mode:

- **Navigate:** `↑↓:navigate  ←→:expand/collapse  space:switch  o:open  c:close  j:jump  /:search  q:quit`
- **Search:** `type to filter  esc:cancel  enter:clear`
- **OpenModal:** `tab:next  shift+tab:prev  ctrl+s:submit  esc:cancel` (varies by sub-mode)
- **Expanded:** `↑↓:navigate  enter:jump to pane  esc:collapse  space:switch`

## 2. Inline Optimistic Updates & Action Progress

### Problem

Actions like opening/closing worktrees happen in the background with no visual feedback until the next refresh cycle.

### Design

A `pendingActions` map in App.tsx tracks in-flight operations:

```
Map<string, { type: "opening" | "closing" | "starting", branch: string, project: string }>
```

| Action | Optimistic UI | On completion | On failure |
|--------|--------------|---------------|------------|
| Open (new worktree) | Insert phantom worktree item with "opening..." in yellow italic | Replace with real worktree data on next refresh | Remove phantom, show inline error briefly |
| Close | Dim the item, show "closing..." | Remove item on next refresh | Restore normal appearance |
| Space (start session) | Show "starting..." next to `○` indicator | `○` becomes `●` on next refresh | Clear status text |

No toasts or notification areas — all feedback is inline on the affected item.

Pending state is cleared automatically when the next refresh cycle detects the actual state change.

## 3. Expandable Worktree Items

### Problem

The tree view shows a single line per worktree with minimal status indicators. Users need to leave the TUI to check PR status, GitHub checks, tmux pane layout, or notification details.

### Design

When a worktree is selected and the user presses `→`, it expands to show detail rows beneath it (same pattern as repos expanding to show worktrees).

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

**Sections:**

| Section | Source | Display |
|---------|--------|---------|
| Notifications | Existing queue data | Message text + pane reference. `enter` to jump to pane |
| PR info | `gh pr list --head <branch>` via cached GitHub data | PR number, title, state |
| Checks | `gh pr checks <number>` via cached GitHub data | Status icon (✓ ✗ ◌) + check name |
| Tmux panes | `tmux list-panes -t <session>` | Pane index, running command, window name |

**Navigation:** When expanded, `↑↓` moves through detail rows. `enter` on a notification row jumps to that pane. `←` or `esc` collapses back.

**Data:** PR and checks come from background GitHub fetch (30-60s cadence). Tmux panes refresh with the regular 5s poll. No extra fetch on expand.

## 4. Background GitHub Data Fetching

### Problem

GitHub data (PRs, checks) is not currently available in the TUI. It needs to be fetched without blocking the UI.

### Design

New `useGitHub` hook that fetches PR and check data for all registered repos on a slower cadence.

**Fetch strategy:**
- Initial fetch on TUI startup
- Re-fetch every 30-60 seconds (configurable, separate from the 5s local poll)
- Uses `gh pr list` and `gh pr checks` via `Bun.spawn`
- Data cached in React state, keyed by repo+branch
- Errors are silently ignored (GitHub data is supplementary)

**Data structure:**

```typescript
type PRInfo = {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  checks: Array<{ name: string; status: "pass" | "fail" | "pending" }>;
};

// Map<`${project}/${branch}`, PRInfo>
```

## 5. Open Modal Redesign

### Problem

The current modal overloads a single form for branch creation, PR opening, and existing branch checkout. PR number conflicts with branch/base fields.

### Design

Three-path flow: mode selector → mode-specific form.

**Step 1 — Mode selection** (when user presses `o`):

```
[ New Branch      ]
[ Open from PR    ]
[ Existing Branch ]
```

Bracket-style list with blinking cursor. `↑↓` to select, `enter` to confirm, `esc` to cancel.

**Step 2 — Mode-specific forms:**

**New Branch:**
- Branch: text input (brackets, blinking cursor)
- Base: text input (pre-filled from selected worktree's branch, fallback to default branch)
- Prompt: textarea (horizontal lines, not brackets)
- Toggles: ☐ No IDE, ☐ No Attach

**Open from PR:**
- PR: scrollable list from cached GitHub data (plain rows with `▸` cursor, no brackets). Type to filter.
- Prompt: textarea (horizontal lines)
- Toggles: ☐ No IDE, ☐ No Attach

**Existing Branch:**
- Branch: scrollable list from `git branch -r` (plain rows with `▸` cursor, no brackets). Type to filter.
- Prompt: textarea (horizontal lines)
- Toggles: ☐ No IDE, ☐ No Attach
- No Base field (not needed for existing branches)

### Focus indicators

- **Text inputs:** Cyan brackets `[ value▎ ]` with blinking cursor for focused field. Dim gray brackets for unfocused.
- **Lists:** Plain rows, `▸` cursor on selected item, no brackets.
- **Textarea (prompt):** Horizontal lines top and bottom (Claude Code style), not brackets.
- **Labels:** Bold + accent color when focused, dim when unfocused.

## 6. Space to Switch/Create Session

### Problem

`enter` switches to a tmux session, but if no session exists the user must use a separate flow. There's no single-key "just get me there" action.

### Design

`space` becomes the primary "switch" key:
- If worktree has an active tmux session → switch to it (`tmux switch-client`)
- If worktree exists but has no session → run `wct up` to create session, then switch (with "starting..." optimistic indicator)

`enter` remains for context-sensitive actions (jump to pane in expanded view, confirm in modal, etc.).

## 7. Visual Style

### ANSI colors

All colors use standard ANSI names (cyan, dim, bold, etc.) so terminal themes control the palette. No hardcoded hex values in the Ink components.

**Color semantics:**
- **Cyan:** Active/focused elements (selected item, focused field, cursor)
- **Bold:** Emphasis (selected items, focused labels, repo names)
- **Dim:** Inactive/unfocused elements
- **Yellow:** Warnings, pending states, changed file counts
- **Red:** Errors, failed checks, notifications
- **Green:** Success, passed checks, active sessions

## Component Changes Summary

| Component | Changes |
|-----------|---------|
| `App.tsx` | Mode enum, keyboard dispatch refactor, pendingActions state, expanded worktree state |
| `TreeView.tsx` | Render expanded worktree detail rows, phantom items for optimistic updates |
| `WorktreeItem.tsx` | Support expanded state, inline status text for pending actions |
| `StatusBar.tsx` | Accept mode prop, render context-aware 2-line hints |
| `OpenModal.tsx` | Complete redesign: mode selector + three form variants |
| `Modal.tsx` | Minor updates to support new content |
| `RepoNode.tsx` | No changes |
| **New:** `useGitHub.ts` | Background GitHub data fetching hook |
| **New:** `ExpandedView.tsx` | Notifications, PR/checks, panes sub-components |

## New Hooks

| Hook | Purpose |
|------|---------|
| `useGitHub` | Fetch PR list and check status per repo on 30-60s cadence via `gh` CLI |

## Data Flow

```
useRegistry (5s) ──→ repos + worktrees ──→ TreeView
useQueue (5s) ──────→ notifications ─────→ TreeView (counts) + ExpandedView (details)
useTmux (5s) ──────→ sessions/panes ────→ TreeView (indicators) + ExpandedView (pane list)
useGitHub (30-60s) ─→ PRs + checks ─────→ ExpandedView (PR info, check status)
useRefresh ─────────→ orchestrates all hooks via poll + fs.watch
```

GitHub data joins the refresh orchestration but on its own slower timer.

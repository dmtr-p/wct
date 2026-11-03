# TUI views and controls

`wct tui` opens an interactive sidebar for Registered Projects. It starts in
the Worktrees view. The Agents view lists observed foreground agents across
those projects.

## Header and view switching

Click **Agents** before **+Add**, or press `g`, to open the Agents view.
Click **Worktrees** or press `g` to return. Returning to Worktrees retains its
selection and expanded Workspaces.

Add Project remains available in either view. Press `?` for the current view's
shortcuts. Narrow terminals use compact header labels (`[A]` for Agents, `[W]`
for Worktrees, and `[+]` for Add Project) to keep the header on one row and
mouse targets aligned with the list.

## Worktrees view

Projects stay expanded. Use Up/Down to navigate, Right to show Workspace
details, and Left to hide them. Multiple Workspaces can remain expanded.
Pane rows support jumping to a pane, toggling its zoom, and killing it with
confirmation.

Workspace rows show agent counts, including for collapsed Workspaces and
detached sessions. Counts use Workspace Identity and appear in blocked,
working, idle, unknown order; retained counts explicitly say stale. Each
linked pane counts once per Workspace. Rows use width-aware truncation to
remain on one terminal line.

## Agents view

Agents are grouped by Registered Project. Only projects with observed
foreground agents appear; linked panes appear once per project. Each agent
shows its branch, tmux pane title (`pane_title`, also `#T`), state, agent type,
and observation freshness. When pane metadata is unavailable or its title is
empty, only the branch appears on the first line. Pane IDs remain internal
action targets.

Idle, blocked, and unknown agents remain listed while their foreground process
is observed. Exited agents disappear with their observation. See
[agent detection](agent-detection.md) for supported agents, state definitions,
freshness rules, and compatibility.

Use Up/Down to select an agent and Enter, Space, or a double-click to switch
the selected tmux client to its pane. Home/End and Page Up/Page Down navigate
the list; wheel scrolling preserves selection. Selection follows the pane's
foreground generation across refreshes.

Press `x` to kill the selected agent's pane, Enter to confirm, or Escape to
cancel. The confirmation appears directly below that agent's status line and
scrolls into view; canceling restores the prior list position. For linked panes
shown under multiple projects, it stays below the selected project's
occurrence.

Long confirmation questions are truncated with an ellipsis to keep the action
controls visible within the agent viewport.

The confirmation names the branch and pane title, keeps its target fixed
across refreshes, and closes if that foreground agent exits or is replaced
before submission. A pending kill keeps the confirmation until it settles;
failed kills can be retried.

Repository and tmux metadata follow the [TUI refresh loop](tui-refresh.md).
PR discovery and updates follow [PR refresh](pr-refresh.md). Agent observations
use the separate loop described in [agent detection](agent-detection.md#observation-and-presentation).

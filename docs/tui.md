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

Open validation expands discovered Workspaces, including after a later phase
fails. Active lifecycles temporarily force expansion without changing the user's
stored preference. Renaming a Project Display Name leaves expansion and action
targets intact because they use Workspace Identity Keys.

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
If that generation disappears or is replaced, selection clears. Use navigation
or click a row to select an agent before jumping to or killing its pane.

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

Press `c` to close the selected agent's Workspace, Enter to confirm, or Escape
to cancel. The confirmation appears below that agent and targets the Workspace
shown under its project. Closing uses the shared
[Workspace shutdown flow](workspace-operations.md), including moving the tmux
client away and asking separately before force-removing uncommitted changes.
The force confirmation remains available after shutdown removes the agent pane.
The Agents view stays open, and the Worktrees view retains its selection.

Repository and tmux metadata follow the [TUI refresh loop](tui-refresh.md).
PR discovery and updates follow [PR refresh](pr-refresh.md). Agent observations
use the separate loop described in [agent detection](agent-detection.md#observation-and-presentation).

## Rendering constraints

The shared visual row model drives rendering, windowing, and mouse hit-testing.
Every model row must occupy one terminal row. Wrapping and truncation use
`src/tui/utils/display-width.ts` for consistent whole-string and grapheme widths;
its approximation can differ from Ink for complex Unicode clusters.

## Quit and runtime lifetime

Each invocation acquires its own ManagedRuntime, shared by its imperative TUI
adapters and WorkspaceService calls. Only one invocation can own the terminal
binding at a time; importing TUI runtime helpers does not acquire resources.

Eligible `q` and Ctrl+C request the same coordinated quit. Input stops accepting
new actions and the TUI displays a waiting message while active Open, Start,
Stop, Close, Project Removal, Add Project, PR merge submissions, and direct tmux
actions (pane kill, jump, zoom, and existing-session switch) drain. The drain includes validation and
follow-up handoff. Repeated quit requests cannot force exit. There is no timeout
or cancellation of mutations; a blocked script can therefore delay quit.
Required down-script failures still keep the worktree, and self-session shutdown
still uses the detached worker and its saved outcome described in
[Workspace Operations](workspace-operations.md#shutdown).

After draining, mouse reporting is disabled before Ink exits and restores raw
mode and the alternate screen. Unmount stops refresh timers, watchers, and
observation publication; the input adapter is disposed before the runtime is
disposed exactly once. Runtime disposal settles remaining background fibers.
Startup and render failures use the same drain and finalization boundary, even
when React has already unmounted. Unmount releases presentation waiters and
skips client handoff when its terminal presentation is gone, including when
unmount happens during client discovery or session ownership resolution. Skipped
switches do not produce failure messages or start refreshes. Operation errors
retain validation behavior; errors received while draining or after unmount are
saved and printed to stderr after terminal restoration and runtime finalization.
Failure does not prevent draining. Close blocked by uncommitted changes during
quit reports the retained worktree and asks for an explicit retry; it does not
open an inaccessible force confirmation or authorize removal.
Ink and React remain lazy imports of the TUI command.

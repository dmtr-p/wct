# TUI repository and tmux refresh

The TUI refreshes registered repositories, worktrees, tmux sessions, panes, and
clients every five seconds and after debounced database file changes. Workspace
actions also request refreshes directly, including during lifecycle validation.
GitHub data uses separate [PR discovery and refresh](pr-refresh.md) coordination.

Every refresh call starts a fresh observation. Registry, session/pane, and client
observations each have an independent request generation. A completion can publish
until a newer result in that group has been accepted, including empty results and
errors. Starting another scan does not suppress an otherwise current completion,
so scans slower than the polling interval still update the display. Sessions and
their panes publish together, so delayed pane reads cannot restore an older
session's panes. Successful client switching and detachment invalidate pending
client discoveries before publishing the action's result.

An overlapping request does not cancel an earlier caller's result. Lifecycle
validation receives the snapshot its own call loaded, even when a newer call has
superseded publication. It never reuses a scan started before its request.
Registry failures return `null` and retain the displayed repositories. Session
discovery failures return an empty list and clear sessions and panes only if the
request is still current. Client discovery preserves its single, multiple, none,
and error outcomes.

Aborting a request prevents it from publishing, including from failure handlers.
Unmount invalidates all pending observations and client action continuations,
including calls made without an abort signal. Cancelled registry calls return
`null`; cancelled session and client discoveries return an empty list and an
error outcome respectively.

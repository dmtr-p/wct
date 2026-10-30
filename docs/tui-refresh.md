# TUI repository and tmux refresh

The TUI inspects registered repositories and tmux state every five seconds.
Changes to the registry database or its WAL file also trigger a refresh after
a 150 ms debounce. Lifecycle validation and explicit actions can request scans
independently of the polling loop.

## Shared subprocess budget

The TUI runtime owns one Local Observation service. Repository inspection,
tmux session/pane scans, and client discovery share its fixed budget of four
concurrent subprocesses, including overlapping timer, watch, and lifecycle
requests. Repository, worktree, and pane traversals also use bounded Effect
concurrency.

Each permit covers one subprocess from launch through output collection and
scoped cleanup. Sequential Git fallback reads acquire separately; enclosing
scans do not acquire permits. Cancelling queued reads removes their wait, and
cancelling running reads cleans up their subprocess before releasing the permit.
Unmount cancels all outstanding observations.

Lifecycle and setup actions and GitHub requests do not use this budget.
Independent scans retain their own results; they are not coalesced or replaced
with cached background observations. The budget applies within one service
instance in one process, without coordinating separate CLI processes.

## Publication and lifecycle validation

Repository, session/pane, and client observations track separate request
generations. Scans may overlap, but a result cannot replace state published by
a newer request. Session and pane results publish together. Cancellation and
unmount prevent later publication; successful client switching or detachment
invalidates pending client observations.

A refresh still returns its own snapshot to an active lifecycle caller when a
newer snapshot is already displayed. This lets each Workspace Operation validate
against the scan it requested. Failed or cancelled repository refreshes return
null and retain the previous tree. Individual repository inspection failures
produce repository-local errors; status failures use zero changed files and
unknown sync status without printing CLI warnings. Failed session discovery
clears the session and pane snapshot.

## Other observation loops

[GitHub PR refresh](pr-refresh.md) owns discovery, cache hydration, and
association updates. [Agent detection](agent-detection.md#observation-and-presentation)
uses a separate one-second observation loop. Neither uses the five-second
registry/tmux cadence.

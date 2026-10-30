# TUI repository and tmux refresh

The TUI inspects registered repositories and tmux state every five seconds.
Changes to the registry database or its WAL file also trigger a refresh after
a 150 ms debounce. Lifecycle validation and explicit actions can request scans
independently of the polling loop.

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

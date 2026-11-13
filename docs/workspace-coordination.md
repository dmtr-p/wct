# Workspace coordination primitives

`WorkspaceCoordinationService` provides host-local scoped ownership keyed by
canonical Main Repository path and exact branch. Its lock/journal directory
defaults to `~/.wct-coordination`, outside `~/.wct` and its registry watcher.
An explicit root supports isolated environments. Keep this directory private
and on a local filesystem; never delete lock or journal files to recover work.

`makeWorkspaceCoordinationService` captures the filesystem used for canonical
paths. `acquire` waits interruptibly for custody and optionally invokes `onWait`.
Different identities progress independently. A retained reservation with no
kernel custodian fails acquisition with `workspace_coordination_error` and the
exact operation/generation to inspect. `inspect` distinguishes `available`,
`busy`, and `outcome-unknown`.

Provide the acquired lease through `CurrentWorkspaceLease` around process work.
`execProcess`, `runProcess`, and `execShell` then persist a command boundary before
spawn and acknowledge the collected exit/output before returning. Known nonzero
exits acknowledge completion; interruption or uncertain collection does not.
Coordination errors propagate through setup/down command execution rather than
becoming optional script warnings. The operation lease remains held between
commands and is scoped independently of each subprocess. Interactive terminal
handoff is outside this collected-process boundary.

`transferWorkspaceToWorker` and `acceptWorkspaceFromCaller` provide the controlled
Bun Ready/Start/Adopted custody boundary. Workers inherit descriptor 4 and must
accept ownership before mutating; ordinary scripts never inherit that descriptor.
Use a scope covering the worker's entire operation and outcome persistence.
The returned child has a dedicated ownership IPC protocol; an adapter needing
progress/result messages must compose those separately. These primitives do not
automatically wrap CLI/TUI lifecycle actions or the existing shutdown runner;
that wiring belongs to the Workspace service adapter.

For an `outcome-unknown` reservation, inspect potentially surviving script work
first. Then call `reconcile(target, request)` with the exact `expectedOwnership`
operation ID/generation, `acknowledgeUncertainSideEffects: true`,
`resolution: "release-after-inspection"`, a unique `requestId`, and a nonempty
`reason`. Reconciliation refuses a live custodian or a stale generation and
never executes scripts. If custody is busy, wait or cancel; reconciliation is
not an override for a running owner. Invalid or unreadable journals fail closed
and require diagnosis rather than automatic deletion. The API is the recovery
boundary for caller adapters; no recovery CLI is installed by this primitive.

See [ADR 0004](adr/0004-workspace-coordination.md) for fsync ordering, acknowledged
background workloads, the crash table, platform requirements and limitations.

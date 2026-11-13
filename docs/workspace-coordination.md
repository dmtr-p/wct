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
progress/result messages must compose those separately. The Workspace service adapter wraps CLI/TUI lifecycle actions and composes
shutdown progress/results with this protocol; see
[Workspace Operations](workspace-operations.md#cross-process-ownership-and-recovery).

For an `outcome-unknown` reservation, inspect potentially surviving script work
first. Then call `reconcile(target, request)` with the exact `expectedOwnership`
operation ID/generation, `acknowledgeUncertainSideEffects: true`,
`resolution: "release-after-inspection"`, a unique `requestId`, and a nonempty
`reason`. Reconciliation refuses a live custodian or a stale generation and
never executes scripts. If custody is busy, wait or cancel; reconciliation is
not an override for a running owner. Invalid or unreadable journals fail closed
and require diagnosis rather than automatic deletion. The owner-local `wct operations inspect` and `wct operations reconcile` commands
expose this recovery boundary; see the
[recovery workflow](workspace-operations.md#cross-process-ownership-and-recovery).

See [ADR 0004](adr/0004-workspace-coordination.md) for fsync ordering, acknowledged
background workloads, the crash table, platform requirements and limitations.

## Repository mutation custody

Shared Git mutation transactions reuse the same durable lock/journal protocol in
`~/.wct-repository-coordination`, a separate namespace keyed by the canonical Git
common directory. Workspace custody precedes repository custody. Only the Git
critical section holds the repository lease; scripts, prompts, network fetches
and worker handoff waits remain outside it.

Process collection participates in both current leases. A known collected nonzero
exit acknowledges both command boundaries before business-error handling. A crash,
interruption or uncertain collection fences both scopes; a crash between commands
also retains the repository reservation. No descriptor is delegated to arbitrary
Git hooks, and parent-death signaling is not proof of descendant quiescence.

Use `wct operations inspect-repository --repo <checkout-or-git-directory>` to see
the common-directory target and exact operation/generation. After inspecting
surviving Git work and partial config/worktree intent, explicitly release it with
`wct operations reconcile-repository --repo <path> --operation <id>
--generation <generation> --acknowledge-uncertain-side-effects --reason <reason>`.
Human and JSON output use the same rules as Workspace recovery. Live/newer owners
are refused. If both scopes are fenced, inspect and reconcile each exact scope;
repository reconciliation never releases a Workspace reservation or replays Git.

Git config/ref locks prevent torn individual writes but do not prove a partially
completed transaction finished. After a crash, inspect remote URLs, worktree/branch
registration and any branch-specific pending push-remote intent before retrying.
Existing pending-intent repair remains available only after explicit recovery;
reconciliation itself neither completes nor rolls back those writes. Unmanaged
Git callers do not participate in this advisory protocol, so removal revalidates
retained checkout/registration evidence after repository acquisition as well.

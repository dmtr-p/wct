# GitHub PR discovery and refresh

The TUI maintains Workspace PR Associations and the Open modal's PR list through
repository-owned discovery and focused detail reads. Shared terms such as
PR Identity, Push Destination, and Explicit PR Association are defined in
the [domain glossary](../CONTEXT.md#pr-identity).

## Discovery and polling

GitHub PR data refreshes every two minutes, when repositories or their worktrees
change, and on explicit refresh actions. Complete PR discovery is cached in
SQLite by Main Repository path; repositories without a usable snapshot scan
their complete history. Automatic refreshes reuse discovery snapshots fetched
within thirty seconds; incomplete association facts can still require GitHub
detail requests.

Ordinary polls read PRs in every state, newest-updated first, stopping after an
inclusive server-timestamp checkpoint with a one-second overlap. This discovers
PRs that closed or merged between polls or while the TUI was closed. Malformed
discovery records fail the scan rather than advancing a checkpoint that could
permanently skip a PR.

Each `PrRefreshService` instance owns an Effect keyed cache for base-repository
resolution, shared by its sessions. Keys combine Main Repository path and
registration identity. Successful results are cached for ten minutes after
resolution completes; failures are not retained. Compatible concurrent lookups
share one resolution. Removal or replacement of a registration invalidates its
entry. Resolution failure backoff remains owned by refresh coordination.

Manual refresh bypasses cache freshness and requests complete historical
discovery and fresh terminal facts. Concurrent manual requests can share a
complete scan. A changed base repository rebuilds discovery when resolution next
runs.

## Association facts and details

Main and linked worktrees use the same Push Destination and Explicit PR
Association rules, cache persistence, and refresh error handling.

Unresolved or live external Explicit PR Associations use batched updates.
Historical candidates and merged PRs use cached facts. Check details are fetched
for live associated PRs and open PR Candidates; terminal associations reuse
complete checks for the same PR and known head. External facts are retained only
while a Workspace explicitly references them.

Complete checks require every page to identify the same PR and known head.
If discovery lacks a node ID, the first detail response establishes it for later
pages. Missing identities, malformed pagination, and unfinished connections leave
checks incomplete. An explicitly null check rollup represents no checks.

Failed detail reads retain the latest discovered lifecycle and head facts;
cached checks are reused only for the same PR, lifecycle state, and known head.
A failed associated PR retains stale data or an unresolved association without
discarding discovery or blocking healthy Workspaces. Sibling candidate errors
do not mark a healthy associated PR as stale.

Push Destination reads run with at most four concurrent Workspaces per
repository. Each Workspace reads its push reference, batches the relevant Git
configuration into one NUL-delimited read, and resolves push URLs sequentially.
This uses at most three subprocesses in total and one at a time per Workspace.

## Refresh coordination and failures

`PrRefreshService` owns refresh coordination, discovery snapshots, retry deadlines,
and registration-fenced persistence. Opening a session requires an Effect scope;
scope finalization marks the session closed before interrupting its owned refresh
fibers. Each mounted TUI hook runs one scoped owner fiber and interrupts it on
unmount, releasing the session automatically. Session acquisition and pending
callers share a readiness Deferred. The shared TUI runtime remains available to
other services. React hydrates cached presentation state, triggers polling, and
receives results through a callback bridge.

Discovery belongs to the repository: modal cancellation and worktree changes do
not cancel it. Worktree changes reconcile against its completed results.
Repository removal, replacement registration, and TUI shutdown cancel owned
requests. Cancelling a caller interrupts only its wait; queued cancelled callers
do not start another refresh.

Concurrent manual refreshes share a running complete scan while still forcing
terminal and external fact reads. Automatic waiters share a failed request's
error; a manual refresh queued behind a failed automatic request still runs.
Concurrent manual waiters share a failed manual attempt.

GitHub reads have two-minute request deadlines, including repository resolution,
PR checkout metadata, summary batches, check detail pages, and merge-preflight
facts and configuration. Full paginated history has a ten-minute deadline instead.
Incremental discovery, summary batches, check details, and merge preflight each
have a ten-minute total read budget. Detail and summary operations retain earlier
successful results when their remaining budget expires. Timeout interrupts the
owned request and waits for scoped process cleanup before settling. Merge and
queue mutations do not use these read deadlines.

Failed discovery without a usable snapshot delays automatic requests for ten
minutes without flashing a refresh indicator. Manual refresh, post-merge reads,
and explicit association changes bypass the delay. Base-repository resolution
failures also delay automatic requests.

## Persistence

Hydration batches modal choices and Workspace caches per repository in one read
transaction. Refresh also batches Workspace inputs per repository. Successful
reads, including cache misses, are remembered for each registration and Workspace
Identity. Unchanged registry polls skip hydration; failed reads retry on a later
update. Removal or a new registration ID resets hydration state, and rediscovered
Workspaces can hydrate again. Hydration preserves facts already in memory.

Malformed Workspace cache envelopes are cache misses. Invalid PR Candidates are
ignored, and malformed or missing checks remain unknown and incomplete. These
entries cannot block healthy Workspaces from refreshing; a successful refresh
replaces the cached payload while preserving Explicit PR Associations.

Repository refresh writes share one scoped SQLite connection for discovery,
Open PR choices, Workspace entries, and pruning. Each write uses an independent
transaction fenced by registration identity, preventing old refreshes from
restoring removed projects' cache rows. A failed write does not roll back healthy
siblings or prevent publication. Pruning only follows a complete repository scan.
Storage errors leave fetched results in memory without applying GitHub discovery
backoff.

Discovery stores changed PR records and its checkpoint separately; unchanged
records are retained. History hydration streams records within one read
transaction, yielding to keep the TUI responsive during large cache loads.

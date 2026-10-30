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

Successful base-repository resolution is cached for ten minutes. Manual refresh
bypasses cache freshness and requests complete historical discovery and fresh
terminal facts. Concurrent manual requests can share a complete scan. A changed
base repository rebuilds discovery when resolution next runs.

## Association facts and details

Unresolved or live external Explicit PR Associations use batched updates.
Historical candidates and merged PRs use cached facts. Check details are fetched
for live associated PRs and open PR Candidates; terminal associations reuse
complete checks for the same PR and known head. External facts are retained only
while a Workspace explicitly references them.

Failed detail reads retain the latest discovered lifecycle and head facts;
cached checks are reused only for the same PR, lifecycle state, and known head.
A failed associated PR retains stale data or an unresolved association without
discarding discovery or blocking healthy Workspaces. Sibling candidate errors
do not mark a healthy associated PR as stale.

Push Destination reads run with at most four concurrent Workspaces, and each
repository loads its Workspace cache inputs through one database connection.

## Refresh coordination and failures

`PrRefreshService` owns refresh coordination, discovery snapshots, retry deadlines,
and registration-fenced persistence. Each mounted TUI hook opens a session with
owned refresh fibers and closes its scope on unmount. The shared TUI runtime
remains available to other services. React hydrates cached presentation state,
triggers polling, and receives results through a callback bridge.

Discovery belongs to the repository: modal cancellation and worktree changes do
not cancel it. Worktree changes reconcile against its completed results.
Repository removal, replacement registration, and TUI shutdown cancel owned
requests. Cancelling a caller interrupts only its wait; queued cancelled callers
do not start another refresh.

Concurrent manual refreshes share a running complete scan while still forcing
terminal and external fact reads. Automatic waiters share a failed request's
error; a manual refresh queued behind a failed automatic request still runs.
Concurrent manual waiters share a failed manual attempt.

Discovery has a ten-minute timeout. Failed discovery without a usable snapshot
delays automatic requests for ten minutes without flashing a refresh indicator.
Manual refresh, post-merge reads, and explicit association changes bypass the
delay. Base-repository resolution failures also delay automatic requests.

## Persistence

Initial modal and Workspace cache reads are batched per repository in one
connection and transaction. Successful reads, including cache misses, are
remembered for each registration and Workspace Identity. Unchanged registry
polls skip hydration; failed reads retry on a later update. Removal or a new
registration ID resets hydration state, and rediscovered Workspaces can hydrate
again. Hydration preserves facts already in memory.

Cache writes are fenced by the project registration identity so removed projects
cannot regain cached rows from old refreshes. Discovery stores changed PR records
and a small checkpoint separately, once per refresh; unchanged records are
retained. History hydration streams records and yields every 128 records within
one read transaction, allowing the TUI to process input during large cache loads.
Database write errors leave fetched discovery available in memory and report a
storage error without applying GitHub discovery backoff.

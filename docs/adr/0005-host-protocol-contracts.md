---
status: accepted
---

# Shared host contracts separate state RPC from terminal transport

## Decision

Use `effect/Schema` and `effect/rpc` from the pinned Effect dependency for shared
application contracts in `src/contracts/`. These are declarations and pure
validation helpers. They do not start a daemon or bypass RFC #327's experiment/
need gate (#345) or single-host validation gate (#353).

State-store identity is durable and initialized atomically within that store.
Labels, routes and filesystem paths cannot establish host identity. Verify the
public identity before sending credentials and again on each attachment
connector. Independently fence resources with host runtime generation, daemon
epoch, and the existing tmux server generation. Reuse Workspace Identity and
#332's verified Workspace Session ownership rather than treating session names
as identifiers.

Commands are semantic lifecycle intent with durable request/operation receipts.
Commit intent before acknowledgement and side effects. A duplicate returns the
same operation; changed intent under the same ID conflicts. The host owns
coordination/status, while local native CLI callers execute scripts in their
calling shell context through fenced plans. Browser/remote operations execute
on the host. Crashes preserve interrupted/unknown outcomes and never replay
arbitrary scripts. Conflicting operations visibly wait and their wait can be
cancelled. Acknowledged command completion ends that command's descendant
boundary and allows intentional background workloads to continue, while the
encompassing Workspace Operation retains ownership between all steps. On macOS
and Linux, ambiguous loss of authoritative supervision leaves durable
`outcome-unknown` fencing and blocks the Workspace until explicit reconciliation.
Dead parents, PID/start-time/PGID checks, timeouts and a free kernel lock cannot
clear this fence. Reconciliation names the uncertain operation and ownership
generation, rejects live/newer owners and cannot replay scripts. #338 owns that
runtime mechanism; these schemas define its host boundary.

Publish a joined sidebar snapshot followed by contiguous revisioned deltas.
Bound subscriber queues and recover gaps/restarts through snapshots. Keep client
presentation state local. Use explicit protocol major/minor negotiation and
versioned capabilities; store record versions separately with additive optional
fields and explicit migrations for incompatible data.

Use one framed stdio state connector per configured host and a separate framed
binary connector per terminal attachment, with stderr reserved for diagnostics,
an explicit execution user and no outer PTY. State frames use Effect's NDJSON
codec; terminal framing carries bounded JSON metadata and raw bytes outside RPC.
Owner-authorized RPC issues expiring single-use tickets; each activated connector
has its own stream ID to fence replaced connections. Terminal target changes are
ordered with output on that connector, while cumulative render acknowledgements
are validated independently of input sequence numbering.
Initial routing supports explicitly configured hosts, the default tmux server,
and a laptop gateway, without a cloud service.

## Rationale and consequences

The current Effect dependency already provides RPC schemas/serialization, so
there is no new runtime dependency or competing handwritten application protocol.
Opaque host identity prevents a reused endpoint from receiving another host's
credential. Separate generations distinguish durable history from invalid
runtime resources without invalidating surviving tmux sessions on every daemon
restart. A committed singleton identity avoids empty-file initialization races.

A single multiplexed terminal/state pipe would allow tmux bursts to delay every
client and operation. Separate connectors establish isolation without inventing
a fair custom multiplexer. They consume SSH sessions, so the connector increment
must choose and validate its `MaxSessions` behavior before readiness.

Receipts need neither an event log nor projection replay. They prevent accidental
re-execution within a declared retention window but do not make scripts exactly
once. Keeping local scripts in their caller environment preserves existing PATH,
agent socket and direnv behavior; it requires fenced execution and a verified
shutdown-worker ownership transfer. A daemon-only executor would change those
semantics for ordinary shell calls.

The [contract reference](../host-contracts.md) defines the message semantics and
lists concrete policy values required from dependent implementation tickets.
Schema fixtures validate compatibility and fencing; runtime race, persistence,
transport and security guarantees require the corresponding implementation gates.

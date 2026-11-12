# Host protocol contracts

`src/contracts/` defines shared Effect schemas and `effect/rpc` declarations for
host implementations and clients. These modules have no daemon, connector
process, persistence, subscription worker, or terminal implementation. They are
not imported by CLI dispatch. The daemon remains gated by RFC #327 and #345;
multi-host routing remains gated by #353. See
[ADR 0005](adr/0005-host-protocol-contracts.md) for the architectural decisions.

## Module boundaries

| Module           | Boundary                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `identity.ts`    | Durable identity, runtime generations, host-qualified Workspace and tmux references       |
| `protocol.ts`    | Public descriptor, version/capability negotiation, typed failures, required policy values |
| `operations.ts`  | Semantic lifecycle intent, receipts/status, caller-shell execution messages               |
| `sidebar.ts`     | Host snapshot, contiguous deltas, resynchronization                                       |
| `attachments.ts` | Attachment controls and separate terminal-frame metadata                                  |
| `connector.ts`   | Explicit-user, framed stdio bootstrap/channel declarations                                |
| `rpc.ts`         | Public handshake RPCs and negotiated application RPCs                                     |

Schemas validate structure and local invariants. Host handlers must authorize the
connection, check negotiated capabilities, compare current generations and
validate resource ownership before side effects. A schema alone does not establish
trust. RPC transport request numbers are unrelated to durable lifecycle request IDs.

## Identity and enrollment

| Field               | Lifetime and meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| `hostId`            | State-store identity; retained with registry and operation records                    |
| `runtimeGeneration` | Host boot/container incarnation; changes on reboot or container restart/recreation    |
| `daemonEpoch`       | Daemon process incarnation; invalidates subscriptions and executor/attachment fences  |
| `serverId`          | Host-local tmux socket path; retained even while only the default server is supported |
| `serverGeneration`  | Existing adapter's socket path + NUL + server PID + NUL + server start time           |

New opaque IDs use cryptographically random UUIDs without semantic labels. A
runtime generation must be shared by daemon restarts within the same boot and
must change across container restarts even when a mounted state store survives.
The implementation must establish an OS/container incarnation source; it cannot
substitute the daemon PID or epoch. Copies of a live state store cannot operate
concurrently as independent hosts with the same ID: clone enrollment must mint a
new ID before serving, and must not reinterpret old runtime resources as local.

Identity initialization belongs in the state store: under a short SQLite write
transaction, read the singleton identity row, insert a complete versioned
`StoredIdentity` only if absent, commit, then publish the descriptor. Competing
initializers reread the winning row. Never publish a generated candidate before
commit. An absent row in a store with no prior identity can be initialized;
empty, malformed or unsupported identity data fails closed and requires explicit
repair. It must not silently mint another ID. File permissions are owner-only
(0700 directories, 0600 durable records). No separate empty identity file or
recovery file can override the committed identity. This specifies initialization;
these contract modules do not modify `wct.db`.

Enrollment explicitly saves `ConfiguredHost.expectedHostId` after the user verifies
the public descriptor over the configured trusted route. `label` is display data.
Every connection, including every terminal connector, compares the public ID
before sending a token, terminal ticket, commands or terminal creation. A mismatch
requires explicit re-enrollment; address changes never imply a new identity.
Identity agreement is not authentication: SSH/Docker or authenticated local/web
transport must still establish the user. All routes for a configured host must
answer as the same state store. An incompatible response stops route fallback.

`WorkspaceRef` wraps the existing canonical Main Repository path and exact branch
with `hostId`. `hostWorkspaceKey` uses the existing `workspaceIdentityKey`
constructor; it does not invent another local key encoding. Empty branch retains
the existing detached-HEAD convention. A worktree path and a session display name
are not identities. `WorkspaceSessionRef` combines that Workspace with its
canonical checkout and verified session reference. Host adapters must use #332's
`ownsWorkspaceSession`/`selectWorkspaceSession` checks; received metadata and
session names cannot authorize a mutation. Session/window/pane IDs always include
the host, host runtime, socket identity and tmux generation. tmux references
survive a daemon restart, while attachments and executor fences do not.

## Compatibility

Protocol version is `{ major: 1, minor: 0 }`. Different majors are incompatible.
For equal majors, the negotiated minor is the smaller advertised minor. Minor
changes must be additive with optional/defaulted fields and no changed meaning
for existing fields. Feature use requires its advertised versioned capability;
clients hide unavailable actions. A minor number alone never enables a feature.
Unknown advertised capability strings are ignored. New required fields, changed
semantics, and incompatible enum additions require a new capability or major.

`DescribeHost` is public and returns identity before credentials. `Negotiate`
checks expected identity, execution user, major compatibility and required
capabilities, in that order. The transport permits only handshake RPCs until
authentication and negotiation succeed. It then permits only advertised actions.
Local socket permission checks and browser Origin/authentication remain mandatory.
Errors have tagged schemas; internal exceptions become an opaque diagnostic ID,
never a serialized cause containing environment variables or credentials.

Persisted schema versions are independent of the wire version. v1 identity and
operation records remain decodable when newer optional fields are absent.
Unrecognized persisted versions require explicit migration or refusal; unknown
status is never success. Durable readers tolerate additive metadata. Mutation
RPC mutations set `Rpc.ParseOptions` to `COMMAND_PARSE_OPTIONS`, rejecting unknown
fields including nested command/configuration fields. Non-RPC acceptance adapters
must pass those same options when decoding before receipt comparison. Durable
readers use ordinary tolerant decoding. Schema annotations do not configure Effect
4 parsing options, so acceptance must use the RPC annotation or explicit decoder
options rather than assume the schema alone rejects extra fields.

## Operations and script execution

`SubmitOperation` carries the caller's request ID, host-qualified target,
`OpenWorkspace`, `StartWorkspace`, `StopWorkspace`, or `CloseWorkspace`, and an
explicit execution context. Start/Stop map to existing `up`/`down` services;
Open/Close retain the current service behavior in
[Workspace Operations](workspace-operations.md). This is not an arbitrary shell
RPC. Confirmation remains client-owned; the host revalidates preconditions and
the confirmed target before mutation.

The execution context records the effective user, absolute host cwd, full
environment snapshot (not a delta against a gateway environment), selected
profile and resolved configuration. WCT environment fields are derived and
verified by the host, including final worktree/work_dir resolution. Secrets stay
on the execution host; public operation/status projections must redact the
environment and script contents before sending them to a different client.
`GetOperation` is an owner-authorized diagnostic read, not the sidebar projection.

For `caller-shell`, the direct local CLI resolves its shell environment,
including PATH, SSH_AUTH_SOCK and direnv, and submits that context. The host
checks it against current canonical targets/configuration before acceptance.
Only a local authenticated native caller may select this mode. Browser and remote
requests select `host`; the host adapter resolves cwd, configuration and
environment under the configured execution user before submitting the canonical
request. No ambient gateway environment or gateway filesystem path is forwarded
as a host execution default. Host execution still owns scripts after disconnect.

Acceptance atomically commits the canonical request, operation ID, ownership/
execution context and initial status before acknowledgement and before side
effects. Conflicting Workspace Operations are accepted as `waiting`, with a
visible `Waiting` phase and blocking operation ID where known. The dedicated
Workspace coordination mechanism owns serialization; receipt writes must not
hold the shared SQLite writer while waiting or executing scripts. Repository-wide
Git mutations also require host-local coordination.

Deduplication is keyed by `(hostId, requestId)` across all Workspaces and callers.
The same decoded parameters return the same operation and original acceptance
time; different parameters produce `RequestIdConflict` atomically. Object-key
order is irrelevant, while script/array order and every environment/configuration
value are significant. `compareReceipt` provides that comparison after strict
decoding; persistence supplies atomicity. Receipt acknowledgement means durable
acceptance, including a possible lock wait, rather than completed side effects.
Receipt retention outlives progress events. `deduplicateUntil` is the committed
receipt boundary, never extended implicitly by a retry. Clients retain their
original ID after lost acknowledgement, query status after reconnect, and never
automatically resubmit after the advertised deduplication window expires.

The host allocates a durable `WorkspaceOperationFence` (Workspace, operation ID,
ownership generation) and an `ExecutorFence` for a caller-shell operation. Only its
registered executor may `AwaitScriptPlan` or `ReportExecutor`. A `ScriptPlan`
contains a monotonic step, one exact setup/down command, cwd and environment.
`ScriptStarted` records PID plus process start identity before execution is
allowed. The host durably grants a step once; loss of a plan or completion
acknowledgement cannot grant another execution. `ScriptCompleted` reports that
command's exit status and a bounded diagnostic reference. Repeated identical
reports are harmless; differing reports for the same fence/step are rejected.
The host validates step order and generation. Script output
uses a bounded diagnostic sink, never the terminal byte stream.

`TransferExecutor` binds the existing fence to a verified detached worker and
returns a fresh execution ID after the worker acknowledges ownership. Transfer
must preserve the Workspace lock with no unowned interval and invalidate the old
executor. A failed handoff retains the original owner or records interruption;
it cannot authorize both executors. These messages consume the coordination
handoff defined by #338/#339 rather than replacing it with a lease.

Cancellation of `scope: wait` removes only a queued operation, producing
`cancelled`; it is unavailable once execution starts. Interrupting an RPC or
disconnecting cancels only that request/subscription, never an accepted operation.
`scope: operation` requests cooperative cancellation at a safe boundary. Running
scripts are not promised rollback or exactly-once execution. Report
`cancel-requested` until process completion is established; do not release the
lock while relevant work remains under supervision or uncertain. Acknowledged
command completion ends that command's descendant boundary, so intentional
background workloads may continue. The encompassing Workspace Operation keeps
ownership continuously between commands and lifecycle steps. Unsupported cancellation returns
`CancellationUnavailable`. A completed operation retains its original outcome.
Cancellation requests themselves use durable request-ID deduplication.

On macOS and Linux, loss of authoritative supervision leaves uncertain relevant
setup/down work in durable `outcome-unknown` status and keeps the Workspace
blocked. Persist uncertainty protection before work can escape supervision.
A dead parent, PID/start-time or PGID checks, elapsed time, or a free kernel lock
are diagnostic evidence, never sufficient authorization to clear uncertainty.
Known quiescent unfinished work can become `interrupted`; ambiguous supervision
loss cannot be converted automatically to a terminal outcome that releases ownership.

`ReconcileOperation` explicitly names the uncertain Workspace/operation/ownership
generation and acknowledges uncertain side effects after inspection. The host
requires an authorized explicit action, verifies the named operation is still
uncertain, rejects a live owner, and atomically compares the current durable
fence with `expectedOwnership`. `sameOperationFence` provides only the equality
check, not proof that work stopped. A stale action cannot clear a newer owner or
generation. Record the reconciliation decision before releasing that reservation;
retain the inspectable outcome and never rerun scripts as part of reconciliation.
#338 owns the lock/fence implementation and #339 its lifecycle integration.

Never automatically replay setup/down scripts or infer failure from a transport
disconnect. State validation follows
success and failure before a `Validating` phase settles; `succeeded` is not a
promise that external Git/tmux state cannot change afterward.

## Sidebar subscriptions

The host produces the joined repository/Workspace/session/lifecycle/PR/agent
summary. Clients own viewport, selection, filters and confirmations. They do not
join independent worktree, tmux, PR-cache and lifecycle scans. Snapshot capture
and subscription registration have one publication boundary: revision N's
snapshot is followed only by N+1 onward, without a scan/subscribe gap.

Revisions are contiguous safe integers within `RuntimeRef`. Each delta carries
its previous revision and the next cursor, with atomic upserts/removals. Nested
references must belong to the cursor's host; adapters must validate consistent
Workspace/session ownership and repository membership before publishing. A client
applies a delta only if `acceptsDelta` succeeds. Duplicate/out-of-order messages,
a gap, runtime change or daemon-epoch change discard buffered deltas and require
a fresh snapshot. A resume cursor is advisory: outside retained revisions, the
host sends a snapshot rather than pretending a partial replay is complete.

Slow subscribers have bounded queues, receive `ResyncRequired` if possible and
are disconnected when necessary. They cannot block observations or operations.
Offline hosts keep a visibly stale cached snapshot; they receive no silently
queued mutations. A reconnect replaces that connection's publication generation
so an earlier connection's snapshot cannot overwrite the newer one. Lifecycle
callers still receive their requested validation snapshot even if a newer result
is already displayed; an operation outcome alone cannot satisfy that validation.

## Attachments and terminal connectors

Creation uses a client request ID and allocates an opaque server attachment ID
plus generation. The ID is also the managed-client marker excluded from native
TUI discovery. Duplicate creation returns the original attachment within the
receipt window; changed parameters conflict. Every control is request-ID
deduplicated, connection-owner authorized and generation-fenced. Creation and
switching reverify Workspace Session ownership on the host. Switching affects
only the requesting tmux client; closing an attachment does not stop its session.

Controls include resize, Workspace switch, suspend, resume and close. Resize and
close acknowledge after prior writes/controls drain. Resume addresses a retained
suspended attachment only; a lost ID returns `NotFound`/`StaleGeneration` and
never silently creates a new session. Expired, lost or changed generations
require a fresh attachment and reset terminal with a tmux redraw. Scrollback is
not replayed; tmux copy-mode retains history. Later implementation may retain a
suspended attachment only within its advertised grace interval.

After creation or resume, the owner calls `IssueTerminalTicket` with the current
attachment reference and a new request ID. The reply includes the secret,
absolute expiry and a `TerminalConnectionRef` with a fresh opaque `streamId`.
Issuance checks the authenticated owner, attachment generation and current
runtime. Repeating an issuance ID returns the same unconsumed/unexpired ticket;
changed parameters conflict. A consumed/expired ticket request returns
`PreconditionFailed`, requiring a new issuance ID. Never extend expiry on retry.
Issuing a new ticket invalidates earlier pending tickets for that attachment but
does not disturb its active stream. Successfully consuming the ticket atomically
activates its stream ID and fences the old connector before accepting bytes.
Ticket expiry/consumption and the owner binding are checked again at bootstrap.
This exchange permits initial connection and renewal without creating another
attachment or granting terminal access to another client.

Terminal bytes never enter `HostRpcs`, sidebar events or operation progress.
One state/command connector serves a host; each attachment has a separate
connector so a terminal cannot block application state or another attachment.
Each terminal direction starts its own data sequence at zero. Output acknowledgements
carry the highest fully rendered output sequence, have zero payload, and release
output credits only after rendering, not on socket receipt. ACKs do not consume
input sequence numbers. `acceptsTerminalFrame` validates contiguous data/control
ordering and rejects ACKs; `acceptsTerminalAck` separately requires a strictly
advancing cumulative acknowledgement no greater than the last output sent.
For example, output 0–5 can be acknowledged as ACK 5 while the next input is 0.
ACKs release only bytes actually sent, with duplicate ACKs ignored and future
ACKs rejected. Every frame/ACK also matches the active stream ID, so delayed
callbacks from a replaced connector cannot affect the current connector.
Input/output queues,
frame lengths and dimensions obey the advertised limits before allocation.
Sequence gaps, daemon/runtime changes, stale attachment generations or tmux server
replacement invalidate the stream and require recovery.

The server sends a zero-payload `TerminalTargetChanged` header (`kind: target`)
as output sequence zero on every new stream, establishing the verified current
Workspace Session. It sends another whenever tmux-side switching or a client
control changes the target. Target headers participate in the same contiguous
output sequence as output bytes: drain old-target output, emit the verified
target header, then emit bytes for that target. The client applies the header
before advancing its expected output sequence and changing its current session.
Thus a tmux key binding can switch sessions without a `SwitchWorkspace` RPC or
dependence on state-connector delivery order. Sidebar updates and control replies
are advisory about terminal targeting; only this stream's ordered target header
changes its expected session. Input with an old target is rejected rather than
routed to the new session. Target headers cannot cross a host/runtime/tmux server
generation; that requires fresh attachment recovery. They are server-to-client
only and have no terminal payload or application RPC event. Stale callbacks
cannot close/resize a replacement attachment.

## Stdio transport

`ConnectorConfig` uses an explicit execution user and direct argv vector. SSH
uses `-T` and an explicit remote user; Docker uses `exec -i --user` without `-t`.
The bridge verifies the effective user, home, state store and default tmux socket.
Only explicitly configured hosts are eligible; no discovery, implicit root user
or arbitrary browser-supplied connector command is permitted. A single per-host
supervisor owns the state connection and jittered bounded backoff. The laptop is
the initial gateway; no cloud service is required.

Stdout is framed protocol only; stderr carries diagnostics, including startup
failure. Before application traffic the bridge emits one UTF-8 NDJSON public
`HostDescriptor`, accepts one `ConnectorHello`, and emits either the negotiated
protocol or a typed error in NDJSON. Bootstrap frames are capped at 64 KiB
including the newline; malformed, oversized or unexpected frames close the
connector. No ticket or token is sent until descriptor identity verification.
Channel/user/capability validation and authentication complete before the bridge
opens command or terminal handling.

After bootstrap, the state channel uses Effect `RpcSerialization.makeNdjson`
with the advertised state-frame bound; RPC handlers use the shared declarations.
The terminal channel instead uses a four-byte unsigned big-endian header length,
that many UTF-8 JSON bytes decoding as `TerminalFrameHeader`, then exactly
`byteLength` raw bytes. Header and payload limits are checked before buffering;
EOF mid-frame is disconnection. `ack` and `target` have no payload. Terminal tickets are
short-lived, single-use, owner-bound and attachment-generation-bound. Bootstrap
never multiplexes terminal payload into state RPC. It uses no outer PTY; the
attachment's PTY exists only on the execution host.

The bridge starts a daemon only when no compatible daemon is listening, under a
socket-path startup lock so simultaneous gateways converge on one daemon.
Disconnect does not stop a daemon or accepted work. Detachment from SSH process
groups/container exec lifetime, socket ownership, startup crash recovery and
upgrade policy belong to the daemon/connector implementation; an incompatible
daemon is reported, never automatically replaced by the connector.

## Required implementation policies

`HostPolicy` requires concrete values and publishes them to clients. Fixtures use
example values, not implementation defaults. Before dependent tickets become
ready, their ADR/issue must record and validate:

- #347/#354: boot/container generation source, authentication, startup lock and
  detachment, bootstrap/header/state frame caps, connection/handshake timeouts,
  backoff and heartbeat behavior, compatibility/upgrade handling.
- #348: subscriber byte/frame caps, revision replay window and slow-consumer
  recovery, observation latency bound and requested-validation snapshots.
- #349/#350: receipt/status/diagnostic retention (independent windows), diagnostic
  byte caps and redaction, permissions/cleanup, process tracking, executor
  handoff, safe cancellation and explicit fenced reconciliation. Receipt/status rows cannot expire
  while work remains active. Diagnostic retention cannot silently extend receipt
  acceptance or shorten the promised deduplication window.
- #351/#344: dimension/frame/queue caps, render acknowledgement credit accounting,
  grace/expiry/heartbeat, attachment limits and sizing/shared-session policy.
- #355–#357: configured-host enrollment, route identity, container volume/clone
  rules and offline detection; SSH `MaxSessions` refusal versus additional
  connections, with a clear attachment-specific error at the chosen cap.

The declarations are groundwork. Passing their schema fixtures does not satisfy
coordination, attachment experiment, daemon, or multi-host rollout gates.

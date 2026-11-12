# Terminal attachments prove ownership through client environment nonces

## Decision

An attachment has an opaque random ID and a separate random generation. Preparing
an attachment resolves a verified Workspace Session, probes the actual tmux
server for client-environment format support, and reserves a single-use launch
record in that server. The launch carries a nonce in the tmux client's own
environment. After attaching, that same client's command queue binds the record
to its server generation, client name, tty, PID and creation time.

Discovery accepts a managed client only when the live client environment and
server record agree. A marker-shaped value, PID, tty, or timestamp alone is not
ownership evidence. Records are server options, so another native TUI process can
verify them without contacting the attachment creator. No daemon is introduced.

Attachment operations first inspect explicit client-name resolution across
sessions, rejecting a tty shadowed by another client, including a suspended
client. They then compare both evidence sources inside a synchronous tmux
`if-shell -F` command queue before switching or detaching. The condition and
mutation must contain no waiting or shell commands: tmux drains this queue before
processing another client's commands or socket events. Launch reservation is
consumed in the same way, preventing replay from rebinding an attachment
reference to a replacement connection. Cleanup compares the exact generation
and record before removing it. Workspace Sessions are never attachment cleanup
resources.

## Compatibility

Managed attachments require the actual server's `V/c` client-environment format
capability. It works for both terminal and control-mode clients; `I/e` does not
expose environment values for clients without a terminal. The probe sends a
fresh nonce in the command client's environment and requires the server to
return it together with the previously resolved server generation. It runs on
every preparation and caches no result across server generations. The launch
rechecks server generation, environment nonce, and unconsumed reservation.
Unsupported servers fail before reserving a record or creating a client.

This is a capability requirement, not a version-number minimum. Older servers
continue to support native CLI/TUI actions and discovery using their available
client metadata; they cannot create managed attachments. Native selections are
connection snapshots, revalidated before action. On older servers, native
discovery uses `list-clients` and preflight followed by the existing explicit
client mutation; it does not use client loops. Their PID/time/tty fingerprint is
not used to establish attachment ownership.

## Constraints

The nonce is passed only to the child tmux process. Managed attach and switch use `-E`,
which prevents `update-environment` from copying it into Workspace Sessions;
preparation requires an already existing server. Callers must not export the
launch environment into their own process or reuse it for unrelated clients.
Connectors must retain exclusive ownership of each managed PTY until its tmux
process exits. tmux addresses terminal clients by tty, not by a unique client
ID. Target inspection and the nonce guard are separate steps; they do not make
arbitrary concurrent reuse of a still-owned PTY safe. Control-mode observers use
their unique live process's client name. A competing controller that fabricates
clients on a managed PTY is outside this ownership boundary.
A native same-user tmux controller can modify all server state and is inside the
trust boundary; these records are resource ownership evidence, not user
authentication.

Server records disappear on tmux restart. A crashed creator can leave a stale
record, but a replacement client's environment cannot satisfy it. tmux omits
suspended/exiting clients from client loops. An unavailable bound record is
retained while its recorded PID might exist; that check can only refuse cleanup
and never proves ownership. Query and detach report this condition explicitly.
Resume the client, or wait for its process to exit, before retrying. Explicit
cleanup of a dead attachment removes only its matching record. The browser
transport owns future timeout and disconnect policy, outside this decision.

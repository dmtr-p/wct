# Terminal attachments

A Terminal Attachment identifies one wct-managed tmux client, independently of
the Workspace Session it currently views. Browser attachments and control-mode
observers have opaque IDs and generations. Several attachments can view the same
Workspace Session, and tmux retains its normal shared window and pane semantics.

## Creation and ownership

`TmuxService.prepareAttachment(target, kind)` resolves an existing verified
Workspace Session and probes its tmux server for `V/c` client-environment
formats. An unsupported server fails before creating a reservation or client.
Native CLI/TUI behavior remains available on older servers. The probe runs on
every preparation; no version-number assumption or cached capability survives a
server restart.

Preparation returns an attachment reference and a single-use launch description
(`command`, `args`, and environment additions). The terminal connector launches
that command with its own inherited environment plus the additions, and owns its
PTY or control-mode pipes. Pass the additions only to this child, never to a
parent process or unrelated clients. Keep a managed PTY exclusive until its tmux
process exits; do not share or recycle it while the process is alive. Observer
connectors add tmux's global `-C` option before the supplied command arguments.
Observers attach read-only and with `ignore-size`.

Preparation reserves a server record. Launch consumes that reservation and
records the actual client identity, checking the server generation and client
environment nonce in the same tmux command queue. Replaying a launch cannot
replace its bound client. Call `detachAttachment` when abandoning a prepared
launch as well as when closing a live attachment.

The record and the live client's environment must agree before discovery treats
it as managed. Stale or malformed records and marker-shaped environment values
are insufficient. See the [ownership decision](adr/0006-terminal-attachments.md)
for compatibility, trust, and command-queue assumptions.

## Query, navigation, and cleanup

`queryAttachment(reference)` returns the live client and its current session,
or null if the reference is no longer bound to that client/server generation.
If tmux omits the client but its bound process may still exist, query reports an
unavailable/suspended error and preserves ownership. Resume the client or wait
for its process to exit before retrying query or detach.
It reads tmux state each time, including session changes initiated inside the
terminal. No mutable session-name map determines attachment identity.

`switchAttachment(reference, target)` resolves verified Workspace Session
ownership and switches only this attachment on the expected server.
`detachAttachment(reference)` detaches only its verified live client and removes
its record. Cleanup of an already dead client removes only a matching stale
record. Neither operation kills a Workspace Session. Stale-generation actions
fail or return an absent query instead of acting on a replacement client.

## Native discovery

Local Observation excludes verified attachments and observers before applying
the native TUI's zero/one/multiple client rule. With one unmanaged client, it can
switch that client while several managed clients coexist. With two unmanaged
clients it selects neither. Unverified markers continue to count as unmanaged.

Native actions carry the complete observed connection fingerprint and validate
the explicit target before mutation. Servers with client-environment formats
also compare the live fingerprint and nonce in a synchronous tmux command queue.
Older servers retain native `list-clients` discovery and explicit actions with a
fresh preflight. A shadowed tty target is rejected. A failed switch or detach
requests discovery again; disappearance cannot silently redirect the action to
a replacement tty.

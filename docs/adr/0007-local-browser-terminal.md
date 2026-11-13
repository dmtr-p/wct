---
status: proposed
---

# Foreground IPv4 loopback browser terminal experiment

## Required input boundary

Strict per-session fencing and the full native tmux keyboard interface are both
required. The foreground CLI currently refuses launch before opening the listener
or creating a client. The raw PTY adapter below is not an approved input boundary:
a single write can contain a tmux session-switch key followed by input, and tmux
can route the remaining bytes to the replacement session before a host query.
A pre-write query or close after detecting navigation cannot undo that routing.
The endpoint cannot be declared ready until a backend checks the expected session
at input consumption without losing the full tmux keyboard interface. Pane-only
input and a native-navigation trust exception do not satisfy these requirements.

## Boundary

The prototype serves embedded manifest assets on `127.0.0.1`, with an
OS-selected port unless `--port` is supplied. It selects an existing verified
Workspace Session using the same current-directory, `--path`, and `--branch`
conventions as `up`. It creates no Workspace, daemon, lifecycle operation,
receipt, observer connector or generic shell RPC. RFC #327's later gates remain
in force. A browser terminal has the privileges of the executing OS user.

The command's Effect scope owns the listener, callbacks, per-tab Bun PTY and
managed tmux child. #341 remains the sole tmux attachment owner. Its capability
probe runs before launching the child. Browser support requires the actual
server's client-environment formats; native CLI/TUI remains available on older
servers. Each PTY stays exclusive until its child has demonstrably exited.

## Authentication and policy

The CLI prints a random 256-bit bootstrap secret in a URL fragment. Browser
code removes the fragment before making a request. A POST exchange consumes it
once within five minutes. A fixed-size failure counter permits at most ten
failed exchanges per minute. The resulting random process-local browser
credential expires absolutely after eight hours. Its randomized server-specific
cookie is host-only, HttpOnly, SameSite=Strict, Path=/, without Domain. HTTP is
permitted solely on this IPv4 loopback listener. Restart invalidates credentials.
No credentials enter localStorage, application diagnostics or WebSocket URLs
except a short-lived single-use ticket. No permissive CORS is offered.

All traffic requires the exact numeric bound Host including port. Privileged
POSTs and upgrades additionally require exactly the listener's HTTP Origin;
missing, foreign, null, malformed and alternate-spelling origins are rejected.
Only manifest keys are served to unprivileged GETs; there is no filesystem or SPA
fallback. CSP limits resources and connections to this origin and denies framing.

Sessions are bounded to 32, pending tickets to 64, in-flight privileged requests
to 32, and live/closing/pending attachments to eight. The single bootstrap
currently issues one shared browser session; these upper bounds do not add a
pairing/session-management feature. A ticket expires after 30 seconds and is
bound to the authenticated owner, endpoint incarnation, attachment generation,
tmux server generation and fresh stream ID. Reissuance supersedes pending
tickets. Validation, consumption and stream activation have no asynchronous gap.
An attachment accepts one stream; renewal/replacement requires a fresh attachment
rather than recovering lost PTY state. Tabs share authentication, not resources.

Terminal payloads are at most 64 KiB, controls and HTTP bodies 16 KiB, dimensions
1–500 columns by 1–200 rows. Input is capped at 256 KiB including queued actions
and conservatively accounted Bun PTY writes; output at 1 MiB including application
queues and WebSocket transport buffering. There are also at most 256 pending
input/control frames and 256 queued output chunks. Browser accounting includes
the full retained frame and a bounded number of renderer callbacks. Limits are checked before copying/enqueueing. Bun's
pre-enqueue WebSocket backpressure limit reserves room for an additional maximum
frame; application checks include framing overhead. Saturation closes only that
attachment. The browser separately bounds pending xterm writes and socket input.

## Local wire adapter

The experiment shares Effect schemas for dimensions, IDs, counters and strict
acceptance parsing with #346. It intentionally does not instantiate `RuntimeRef`,
`HostDescriptor`, host RPCs or durable identity. `LocalRef` names an ephemeral
endpoint UUID, attachment ID/generation and #341's actual tmux server generation
string. `LocalTarget` carries canonical local Workspace paths/branch and verified
server/session IDs. These are experiment-local references, not enrolled hosts.

Creation and ticket issuance are authenticated POSTs. A separate WebSocket carries
binary terminal frames: four-byte big-endian JSON header length, a strict UTF-8
schema-decoded header, then exactly the declared raw bytes. Headers carry explicit
local connection/target, direction, sequence and byte length. The first output
frame establishes the verified target with no payload; output follows with
contiguous sequence numbers. Client input has its own contiguous sequence.
Server-only target/output headers, foreign/stale references, unknown fields,
invalid lengths and out-of-order input are rejected.

This first experiment fixes the CLI-selected Workspace Session. Every queued
input action and output batch rechecks the managed client and original verified
Workspace Session. Navigation away closes the attachment, discarding pending
output; #343 will supply ordered changes to another verified target. It does not
claim that sampling tmux state assigns each historical PTY byte to a pane. These ownership checks do not establish the required input-consumption fence,
including for native navigation; the CLI stays unavailable. There is no stream
replacement in this prototype.

Only close controls are exposed, on the same per-attachment connector as input,
with an increasing control sequence. There is no successful resize or renderer
acknowledgement promise. Initial sizing uses the browser container and tmux's
normal shared-session policy; refreshing the page would create a fresh size.
#344 owns evaluated resizing and render credits.

## Lifetime and platform evidence

Launch and first socket handshake each have a ten-second deadline. The server
pings every 30 seconds, closes after 60 seconds without pong, and checks absolute
browser-session expiry while a stream is open. Disconnect has no retained PTY
grace. Cleanup stops input, discards bounded unsent output, attempts verified
client detach and child exit within a shared two-second budget, then
sends TERM to only its own child, followed after two seconds by KILL and an awaited
exit. No timeout frees/recycles a PTY or attachment slot. Failed/unavailable detach
and retained ownership have credential-free diagnostics. Neither cleanup nor
server shutdown kills a Workspace Session, tmux server or workload.

[Pinned Bun 1.4.4 source](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/runtime/api/bun/Terminal.rs) and its installed `bun-types` document that `Terminal.write` accepts
all bytes and buffers internally; its return value is not a partial-write count.
The raw prototype therefore retains conservative outstanding-byte accounting
until a PTY drain callback, never re-sends a remainder, and closes on saturation.
Immediately flushed writes may never emit drain; this accounting is conservative
and can expire an idle input allowance. It is another reason the raw prototype
is not a completed input adapter. It does
not infer child exit from PTY EOF. Bun PTY is a POSIX capability; release targets
remain macOS/Linux. Regression coverage uses real Bun WebSockets/PTYs and isolated
tmux sockets, with an explicit capability-dependent skip when the live server
cannot support managed attachments. A skip is not evidence for that platform.

Current usage and limits are in [browser terminal](../browser-terminal.md).

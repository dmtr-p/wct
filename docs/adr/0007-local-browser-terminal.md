---
status: proposed
---

# Foreground IPv4 loopback browser terminal experiment

## Input trust boundary

Authenticated bytes have ordinary owned tmux client semantics, including the full
native keyboard interface. Prefix commands may switch sessions, and later bytes
in the same write may reach the newly selected session. The maintainer permits
this explicitly. There is no per-byte expected-Workspace confinement, pre-write
session guard or close solely for native navigation. Authorization binds the
browser to an attachment/stream/server generation; explicit host controls and
initial creation still validate their actual targets.

## Boundary

The endpoint serves embedded manifest assets on `127.0.0.1`, with an
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
string. `LocalTarget` carries verified Workspace paths/branch or an observed
native session name, together with actual server/session IDs. These are
experiment-local references, not enrolled hosts.

Creation and ticket issuance are authenticated POSTs. A separate WebSocket carries
binary terminal frames: four-byte big-endian JSON header length, a strict UTF-8
schema-decoded header, then exactly the declared raw bytes. Headers carry explicit local connection, direction, sequence and byte length.
Input carries no expected session: it addresses only the owned raw client. Output
and zero-payload target observations share a contiguous sequence. Sequence zero
establishes the initially verified Workspace Session. Subsequent observations can
name any native tmux session; Workspace paths are included only when verified.
An observation precedes output published with that observation. Buffered PTY data
can span a session change before polling observes it, so these headers do not
attribute historical bytes atomically. The browser displays the observed session
without a sidebar. Unknown fields, invalid lengths, server-only headers on input,
stale attachment/stream references and out-of-order input are rejected.

There is no stream replacement or explicit switch API in this experiment. A fresh
attachment has a new generation and stream; an old socket never reaches it. Close
controls re-query and compare the explicit observed target as well as connection
references. Shared daemon contracts retain their own stronger target/control
rules; this local adapter does not pretend to implement those RPCs.

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
The endpoint therefore retains conservative outstanding-byte accounting until a
real PTY drain, never re-sends a remainder, and closes on saturation. Immediately
flushed writes may never emit drain. The maintainer approved the resulting
conservative 256 KiB input budget: even an idle PTY can exhaust it through
cumulative input, requiring a fresh attachment. This evidence-based restriction is
advertised as `inputAccounting: conservative-until-drain` and explained in the
disconnect message and usage docs. Time, output and tmux queries cannot prove
input drain and do not release credit. It does
not infer child exit from PTY EOF. Bun PTY is a POSIX capability; release targets
remain macOS/Linux. Regression coverage uses real Bun WebSockets/PTYs and isolated
tmux sockets, with an explicit capability-dependent skip when the live server
cannot support managed attachments. A skip is not evidence for that platform.

Current usage and limits are in [browser terminal](../browser-terminal.md).

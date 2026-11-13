# Local browser terminal

Run `wct browser` in a Workspace with an existing verified tmux session, or select
it with `--path <worktree>` or `--branch <branch>`. `--port <port>` selects a port;
the default is OS-selected. The command stays in the foreground and prints a
one-time bootstrap link. Open it in a local browser. Another tab on the same
origin shares authentication and creates its own tmux client and exclusive PTY.
Ctrl-C closes experiment-owned clients and connections while Workspace workloads
keep running. No Workspace lifecycle API, daemon or shell-command RPC is exposed.

The endpoint binds only `127.0.0.1`. Treat a browser terminal as shell access with
the executing user's privileges. Normal tmux keys work, including prefix commands,
copy mode and session navigation. Input is authorized to the owned tmux client,
not confined to the previously observed Workspace: a session switch and later
bytes in one input burst can reach the newly selected session. Browser metadata
shows the last observed session; polling cannot attribute each byte atomically.
See [ADR 0007](adr/0007-local-browser-terminal.md) for the architectural rationale.

## Authentication and limits

The 256-bit bootstrap secret expires after five minutes and can be exchanged once.
The browser clears its fragment before exchanging it. The process-local host-only
HttpOnly SameSite=Strict cookie expires absolutely after eight hours. Exact Host
and Origin checks protect privileged requests. WebSocket upgrades require that
cookie and a single-use owner/generation/stream-bound ticket, valid for 30 seconds.
The cookie has a randomized server-specific name, Path=/ and no Domain. Credentials
never enter localStorage or diagnostics. The only WebSocket URL credential is its
short-lived ticket. Failed bootstrap exchanges are limited to ten per minute.
Browser sessions are capped at 32 and pending tickets at 64; the single bootstrap
issues one shared browser session, not a pairing-management feature.

Every request requires the exact numeric Host including the bound port. Privileged
POSTs and upgrades also require exactly that HTTP Origin; missing, null, foreign,
malformed or alternate-spelling origins are rejected. Unprivileged static GETs
may omit Origin. Static serving accepts only manifest paths, with no filesystem
or SPA fallback. CSP restricts resources and connections to this origin and denies
framing; there is no permissive CORS. Restart invalidates every credential and
attachment. Keep bootstrap links private.

Creation publishes the policy: 64 KiB terminal payloads, 16 KiB controls and HTTP
bodies, dimensions 1–500 columns by 1–200 rows, 256 KiB input and 1 MiB output
including WebSocket transport buffering. At most eight pending/live/closing
attachments exist, with at most 32 in-flight privileged requests, 256 queued
input/control frames and 256 output chunks per attachment. Limits are checked
before copying or enqueueing. Bun's pre-enqueue WebSocket backpressure threshold
reserves space for an additional maximum frame; application accounting includes
framing overhead. Browser rendering counts full retained frames and limits pending
callbacks. Saturation closes only that attachment. Tabs share authentication,
not attachment resources.

Bun 1.4.4 accepts complete PTY writes without exposing pending bytes. Its drain
callback need not fire for immediately flushed input. The approved conservative
input budget counts accepted bytes until a real drain event; **256 KiB of typing
can therefore exhaust a tab's budget even when the PTY is idle**. The disconnect
message explains that reloading creates a fresh attachment. Idle time, output and
polling never replenish input credit. No partial write is retried.

Initial dimensions come from the browser container and use tmux's normal shared
session sizing. There is no live resize, renderer credit, scrollback replay or
automatic reconnect. Reloading creates a fresh client and screen. Sidebar
navigation and evaluated sizing/reconnect remain in #343/#344.

## Local wire adapter

The endpoint uses shared Effect schema primitives and strict acceptance parsing,
not daemon RPCs or durable host identity. LocalRef carries an ephemeral endpoint
UUID, attachment ID/generation and actual tmux server generation. LocalTarget
carries verified Workspace paths/branch or an observed native session name,
together with actual server/session IDs.

Authenticated POSTs create attachments and issue tickets. Reissuance supersedes
pending tickets. Validation, consumption and stream activation have no async gap.
Each attachment accepts one stream; renewal requires a fresh attachment rather
than recovering PTY state. Old sockets cannot reach a replacement attachment.

A separate WebSocket carries binary terminal frames: a four-byte big-endian JSON
header length, a strict UTF-8 schema-decoded header and exactly its declared raw
payload. Headers identify connection, direction, contiguous sequence and byte
length. Input addresses the owned raw client without an expected session. Output
and zero-payload target observations share one sequence; sequence zero establishes
the initially verified Workspace Session. Later observations may name native
sessions, with Workspace metadata only when verified. An observation precedes
output published with it, but buffered data may span an unobserved session change.
Unknown fields, malformed lengths, server-only input headers, stale references
and out-of-order input are rejected.

Only close controls are exposed, on the same ordered connector as input. Each
has an increasing control sequence, connection references and an explicit target
that is re-queried and compared. There is no switch API, stream replacement,
successful resize or renderer-acknowledgement promise in this experiment.

## Lifetime

Launch and initial connection each have their own ten-second deadline. The server
pings every 30 seconds; 60 seconds without pong or browser-session expiry closes
the stream. Disconnect has no retained PTY grace. Cleanup stops input, discards
bounded unsent output, attempts owned-client detach and waits up to two seconds,
then sends TERM to only its child, waits two seconds, and sends KILL if needed.
The PTY stays owned until child exit is confirmed, including suspension or
unavailability. The attachment slot also remains reserved until queued actions
and observations settle; timeouts do not recycle custody. Detach failures have
credential-free diagnostics. No cleanup kills a Workspace Session or tmux server.

Managed attachments require the live tmux server's client-environment format
capability. Unsupported servers fail before launching a client; native CLI/TUI
remain available. Bun PTYs require POSIX; capability-dependent regression skips
are not evidence that a platform supports this endpoint.

[Terminal attachments](terminal-attachments.md) describes ownership;
[browser assets](browser-assets.md) describes embedding and notices.

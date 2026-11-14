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
including unsent output, unacknowledged renderer frames and WebSocket transport buffering. At most eight pending/live/closing
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

## Rendering and recovery

Output and target/resize headers share a contiguous output sequence. Input has
its own contiguous sequence. Cumulative binary ACKs name an output sequence and
its recorded target; they never consume an input or control sequence. A target
header is consumed immediately, while terminal bytes are consumed only in the
xterm write callback. The browser advances ACKs only through contiguous consumed
frames, including across native session changes. Duplicate, future, foreign-target
and stale-stream ACKs close that attachment. Receiving WebSocket bytes alone
releases no renderer credit.

The server charges queued chunks at payload plus the maximum 16 KiB header and
132 bytes of framing/retention allowance. Sent frames retain their actual encoded
size plus 128 bytes of accounting overhead until ACKed. The 1 MiB budget also
includes Bun's current transport buffering, conservatively counting any overlap.
At most 256 queued plus unacknowledged frames are admitted. A full budget closes
only its attachment; it does not pause another client. The oldest unacknowledged
frame has a ten-second consumption deadline. Browser retention has the same
byte/frame caps, and includes full underlying frames rather than payload views.

On transport loss, the browser disables input, disposes its old xterm instance
and creates a fresh attachment with a new exclusive PTY, attachment generation,
ticket and stream. The new tmux attach emits its initial redraw even with unchanged
dimensions. No bytes or input from the old stream are replayed. Browser scrollback
resets; tmux copy-mode retains tmux history. Old socket callbacks, renderer
callbacks, resize observers and input listeners cannot address the new stream.

There is no disconnected PTY grace. A final query captures the old client's actual
session before detach, including navigation whose target header never arrived.
Recovery waits for confirmed child exit and all old callbacks to settle before
creating a replacement. At most 32 owner-bound recovery references remain for two
minutes; these retain target metadata, never a disconnected PTY. Expiry or eviction
requires explicit new selection. A retried recovery creation returns the same pending attachment and its original
grid if its HTTP response was lost. It cannot allocate another client or close the
replacement. Once that attachment connects or expires, retrying its predecessor
fails. Recovery records and pending-attachment deadlines are not extended by retries.
Preparation and launch verify the exact server generation/session ID and current
Workspace ownership, never resolve a replacement by session name or branch.
A changed or missing Workspace/session stops recovery explicitly. If tmux switches
a client automatically when its old session disappears, that disappearance closes
the attachment rather than accepting the substitute. Native navigation between
still-existing sessions remains allowed. Native names are display data; a rename
does not change the server/session identity used by controls and recovery. A failed final observation also stops
recovery instead of guessing a stale target.

Reconnect uses jittered exponential delays from 500 ms to ten seconds, bounded by
the two-minute recovery window. Cleanup-in-progress and capacity responses retry;
authentication, expired recovery and target refusal stop with visible guidance.
A connection established for 60 seconds resets the retry window and backoff.
The bootstrap exchange is never replayed. No lifecycle action or input is retried.

## Live and shared sizing

Container changes are coalesced over 100 ms and clamped to 1–500 columns by 1–200
rows. Resize controls use the same ordered socket as input and carry the exact
attachment, stream, target, increasing control sequence and last input watermark.
The browser pauses input until the resize reply and applies the new xterm grid
only after that reply. The server verifies the target again after draining accepted
input and all queued and sent output, including output published during target verification. Only a real Bun drain supplies input
credit; renderer ACKs supply output credit. Both must settle within two seconds,
or the attachment closes and fresh recovery uses the new container dimensions.
Consequently, the approved conservative input accounting can force fresh recovery
on resize after typing, even when input has actually flushed. No drain success is
inferred from idle time. Resize changes the owned PTY's grid and signals only its
owned tmux child with SIGWINCH; the signal is needed by the observed Bun/Darwin
spawn behavior. Close/disconnect aborts bounded pending data and reports no successful
drain acknowledgement.

Browser clients participate in normal shared tmux window sizing. The endpoint
preserves each window's configured `window-size` option and does not change user
options or create grouped sessions. `latest` follows the most recently active
client; `smallest` constrains all viewers to the smallest participating grid;
`largest` uses the largest grid and smaller viewers see a viewport. `ignore-size`
excludes a client from sizing, so it is used for read-only observers, not interactive
browser terminals. Pane layouts and current windows retain tmux's shared semantics.
An isolated Bun 1.4.4/tmux 3.8 probe with 80×24 and 120×40 clients produced 80×23
for `smallest` and 120×39 for `largest` and the newly active larger client under
`latest` (one status row). Ignoring the small client left 120×39; resizing/signalling
the native client produced 110×34 while the observer remained excluded. These
measurements establish the evaluated shared policy, not cross-platform support.
Sidebar navigation remains a separate feature.

## Local wire adapter

The endpoint uses shared Effect schema primitives and strict acceptance parsing,
not daemon RPCs or durable host identity. LocalRef carries an ephemeral endpoint
UUID, attachment ID/generation and actual tmux server generation. LocalTarget
carries verified Workspace paths/branch or an observed native session name,
together with actual server/session IDs.

Authenticated POSTs create attachments and issue tickets. Reissuance supersedes
pending tickets. Validation, consumption and stream activation have no async gap.
Each attachment accepts one stream; recovery creates a fresh attachment rather
than retaining PTY state. Old sockets cannot reach a replacement attachment.

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

Resize and close controls use the same ordered connector as input. Each has an
increasing control sequence, connection references and an explicit target that is
re-queried and compared. Resize includes the processed input watermark and an
ordered zero-payload reply; no separately transported control can overtake input.
There is no switch API or retained-stream resume. This local adapter has no daemon
RPC acknowledgement, durable host identity or durable request receipt.

## Lifetime

Launch and initial connection each have their own ten-second deadline. The server
pings every 30 seconds; 60 seconds without pong or browser-session expiry closes
the stream. Disconnect has no retained PTY grace. Cleanup stops input, discards
bounded unsent output, attempts owned-client detach and waits up to two seconds,
then sends TERM to only its child, waits two seconds, and sends KILL if needed.
Final recovery target capture has its own two-second deadline before detach;
an unsettled observation retains its slot even after that deadline.
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

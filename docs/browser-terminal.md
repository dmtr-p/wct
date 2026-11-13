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
See [ADR 0007](adr/0007-local-browser-terminal.md) for the trust and wire boundary.

## Authentication and limits

The 256-bit bootstrap secret expires after five minutes and can be exchanged once.
The browser clears its fragment before exchanging it. The process-local host-only
HttpOnly SameSite=Strict cookie expires absolutely after eight hours. Exact Host
and Origin checks protect privileged requests. WebSocket upgrades require that
cookie and a single-use owner/generation/stream-bound ticket, valid for 30 seconds.
Restart invalidates every credential and attachment. Keep bootstrap links private.

Creation publishes the policy: 64 KiB terminal payloads, 16 KiB controls and HTTP
bodies, dimensions 1–500 columns by 1–200 rows, 256 KiB input and 1 MiB output
including WebSocket transport buffering. At most eight pending/live/closing
attachments exist, with bounded frame counts and HTTP requests. Saturation closes
only that attachment. The browser also bounds retained renderer frames and input.

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

## Lifetime

Launch and initial connection each have their own ten-second deadline. The server
pings every 30 seconds; 60 seconds without pong or browser-session expiry closes
the stream. Disconnect has no retained PTY grace. Cleanup stops input, discards
bounded unsent output, attempts owned-client detach and waits up to two seconds,
then sends TERM to only its child, waits two seconds, and sends KILL if needed.
The PTY and attachment slot stay owned until child exit is confirmed, including
suspension/unavailability. No cleanup kills a Workspace Session or tmux server.

Managed attachments require the live tmux server's client-environment format
capability. Unsupported servers fail before launching a client; native CLI/TUI
remain available. Bun PTYs require POSIX; capability-dependent regression skips
are not evidence that a platform supports this endpoint.

[Terminal attachments](terminal-attachments.md) describes ownership;
[browser assets](browser-assets.md) describes embedding and notices.

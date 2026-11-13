# Local browser terminal prototype

`wct browser` currently refuses launch before loading the endpoint, opening a
listener or creating a tmux client. Strict per-session input fencing and the full
native tmux keyboard interface are both required; the raw PTY adapter does not
establish that boundary. See the proposed [ADR 0007](adr/0007-local-browser-terminal.md).
The prototype is incomplete and is not a usable public endpoint.

## Implemented prototype

The service harness serves embedded manifest assets on `127.0.0.1`, with an
OS-selected or explicit port. Its unexposed CLI adapter selects an existing
verified Workspace Session through current-directory, `--path` and `--branch`
conventions. It creates no Workspace, daemon or lifecycle operation.

A 256-bit, single-use bootstrap secret expires after five minutes. The browser
removes its fragment before authentication. A process-local host-only HttpOnly
SameSite=Strict cookie expires absolutely after eight hours. Exact Host and
Origin checks protect privileged requests. Tickets are single-use,
owner/generation/stream-bound and expire after 30 seconds. Tabs share browser
authentication but have separate tmux clients and exclusive PTYs.

Bounds are published in the creation reply: 64 KiB data frames, 16 KiB
controls/bodies, 1–500 columns, 1–200 rows, 256 KiB conservatively accounted input,
1 MiB output including socket buffering, and eight pending/live/closing
attachments. Application queues also have frame/chunk count limits. Failed
bootstrap exchanges are limited to ten per minute. Input accounting remains
conservative until Bun reports drain; immediately flushed writes need not report
it, so the prototype can exhaust its allowance despite an empty PTY buffer.

Initial dimensions use the browser container and tmux's shared-session sizing.
There is no resize control or renderer drain acknowledgement. Launch and initial
connection have ten-second deadlines. Pings run every 30 seconds; 60 seconds
without pong closes a stream. Cleanup uses a shared two-second detach/exit budget,
then TERM for two seconds, followed by KILL and an awaited child exit. Ownership
and PTY exclusivity remain until that exit is confirmed. Cleanup targets only the
owned client, leaving Workspace Sessions and workloads running.

## Unsatisfied input invariant

The prototype checks client/session ownership before writing a frame to its PTY.
That cannot prevent a frame containing tmux session-switch keys followed by text
from reaching another session: tmux consumes those bytes internally before the
host can query again. Closing after observing navigation cannot undo the input.
Native navigation is not an exception to strict session fencing. A pane-only
input backend does not preserve the required tmux keyboard interface either.
Neither alternative is authorized.

The CLI remains unavailable until an input adapter proves the expected session
at consumption while preserving tmux's keyboard behavior. Sidebar navigation,
reconnect, render credit and evaluated sizing remain separate follow-ups.
[Terminal attachments](terminal-attachments.md) describes the existing ownership
boundary; [browser assets](browser-assets.md) describes embedding and licenses.

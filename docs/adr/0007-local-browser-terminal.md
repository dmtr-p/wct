---
status: proposed
---

# Foreground IPv4 loopback browser terminal experiment

## Decision and scope

Use a foreground, IPv4 loopback endpoint with embedded manifest assets and one
exclusive Bun PTY and managed tmux client per browser attachment. Keeping the
listener and children inside the command's Effect scope gives the experiment
one lifetime without introducing a daemon or durable host enrollment. Reuse
[terminal attachment ownership](../terminal-attachments.md) rather than creating
another client classifier. A PTY stays exclusive until its child demonstrably
exits; pending callbacks retain their attachment slot until they settle.

The endpoint attaches to an existing verified Workspace Session. It provides no
Workspace lifecycle API, generic shell RPC, receipt or observer connector.
RFC #327's later rollout gates remain in force. Current invocation, authentication,
policy values and cleanup behavior belong in
[local browser terminal](../browser-terminal.md).

## Input trust boundary

Authorize input to the owned tmux client, preserving the full native keyboard
interface. Prefix commands may switch sessions, and subsequent bytes in the same
write may reach the newly selected session. The maintainer explicitly accepts
that shell-access boundary instead of per-byte expected-Workspace confinement.
Polling cannot make a raw PTY write atomic with tmux's internal session changes;
pane-only injection would remove native prefix commands. Neither is used as a
substitute for ordinary tmux keyboard behavior.

Keep attachment, stream and server-generation fencing. Initial creation and
explicit host controls still validate their actual targets. Target observations
are snapshots, not atomic attribution of historical bytes to a Workspace. Native
navigation alone does not close an attachment.

## Authentication and resource rationale

Bind only numeric IPv4 loopback so this experiment creates no remote-access
surface. Bootstrap through a one-use fragment secret and a process-local cookie
so the long-lived browser credential stays out of URLs and restart invalidates
access. Exact Host and Origin checks defend the loopback trust boundary against
foreign pages and alternate hostnames. Manifest-only static serving and a
restrictive CSP avoid a general filesystem or framing surface. A short-lived,
one-use owner/generation/stream ticket binds each WebSocket activation to the
authenticated attachment without an asynchronous consume/activate gap.

Bound application queues, transport buffering, retained renderer frames and
attachment counts together: bounding only an application queue would leave
memory growth in Bun or xterm. Saturation closes the affected attachment rather
than retrying ambiguously accepted bytes. Authentication values, limits and
deadlines are specified once in the
[topic document](../browser-terminal.md#authentication-and-limits).

## Local adapter instead of daemon contracts

Reuse shared schema primitives and strict decoding while keeping endpoint IDs
explicitly ephemeral. Actual attachment and tmux server generations are useful
now; inventing a durable RuntimeRef or enrolled HostDescriptor would misrepresent
this foreground process as the later host daemon. The
[local wire adapter](../browser-terminal.md#local-wire-adapter) therefore has its
own references and a separate binary terminal connector. Shared daemon RPCs
retain their own target and control requirements.

## Bun input accounting

[Pinned Bun 1.4.4 source](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/runtime/api/bun/Terminal.rs)
and installed bun-types establish that Terminal.write accepts all bytes and may
buffer internally; its result is not a partial-write count. Immediately flushed
writes need not emit drain, and no public pending-byte getter exists. Time,
output and tmux observations cannot prove that input drained.

The maintainer accepts a conservative 256 KiB accepted-input budget replenished
only by a real drain event. Even an idle PTY can exhaust that budget through
cumulative input and require reattachment. This preserves a hard bound without
fabricating credit or resending already accepted bytes. The advertised accounting
mode and disconnect guidance make the limitation visible; current behavior is
documented in [authentication and limits](../browser-terminal.md#authentication-and-limits).

## Platform boundary

Bun PTY is a POSIX capability, and managed tmux ownership depends on the actual
server's client-environment formats. Probe capability rather than inferring it
from a numeric tmux version; native CLI/TUI remains usable on older servers.
Neither PTY EOF nor a timeout proves child exit. Cleanup targets only the owned
client and retains custody until exit, preserving Workspace workloads.
Capability-dependent regression skips are not support evidence. See the
[lifetime contract](../browser-terminal.md#lifetime) for cleanup sequencing.

## Fresh recovery and shared sizing

Recover with a new tmux client into a new renderer rather than retaining a PTY
whose disconnected output was discarded. Tmux's attach redraw reconstructs the
visible screen without replaying device queries or relying on a dimension change.
Wait for old PTY custody to end; a recovery reference authorizes only its verified
current session, never a new Workspace session found under the same name.

Keep render credit until xterm reports write consumption, separately from input
sequence accounting. Transport delivery cannot establish renderer consumption.
Use the ordered terminal connector for resize, with explicit input and renderer
drain boundaries rather than a second control transport with implicit ordering.

Preserve configured tmux window sizing: changing a shared window option for a
browser would also change native clients' behavior. Interactive browser clients
participate in that existing policy, while observers always ignore size. See
[live and shared sizing](../browser-terminal.md#live-and-shared-sizing) for limits,
evaluated alternatives and the conservative drain limitation.

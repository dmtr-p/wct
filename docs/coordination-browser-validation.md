# Integrated coordination and browser validation

This procedure collects the interaction evidence required by [#345](https://github.com/dmtr-p/wct/issues/345).
Record run outcomes, raw logs, platform limitations and the rollout assessment on
the issue, outside current-behavior documentation. Passing implementation tests
does not clear this gate. Technical validation and a named second-host need or
material duplicate-observation cost are independent inputs.

## Isolation and source identity

Use a disposable directory, child-process home directory, repositories and tmux
socket. Never point a destructive scenario at a registered user repository or the
default tmux server. Preserve the user's environment in the invoking shell; set
the isolated home and executable path only in fixture subprocess environments.
Clear inherited `TMUX`, `TMUX_PANE` and repository-specific `GIT_*` variables.
Disable inherited Git configuration in the disposable repositories.

Record before each platform run:

```sh
git fetch origin
git rev-parse origin/main HEAD 'HEAD^{tree}'
git status --short
git config --get core.hooksPath
uname -a
mise exec -- bun --version
tmux -V
mise exec -- bun install --frozen-lockfile
mise exec -- bun run prepare
```

Run preparation in the bound worktree. Tests and lint remain owned by the enabled
[normal hooks](development.md#hooks). Source execution uses
`mise exec -- bun run src/index.ts`; record whether a scenario instead uses a
compiled binary, its hash and build command. Preserve generated browser asset
input hashes with the evidence. Record any instrumentation or fixture code
separately from the application SHA.

Put a `tmux` executable ahead of the real executable in the fixture children's
`PATH`. It must forward every invocation to the same absolute socket:

```sh
#!/bin/sh
exec /absolute/path/to/tmux -S /absolute/disposable/tmux.sock -f /dev/null "$@"
```

Configure that server's default shell and new-window working directories to use
the fixture. Include the wrapper in all CLI, TUI, endpoint, worker and native
client environments. Confirm the actual server fingerprint with
`display-message -p '#{socket_path}|#{pid}|#{start_time}'`. Record successful
`prepareAttachment` and matching live-client/server metadata as capability
evidence; a version string alone is insufficient. An unsupported managed path
must not prevent a separate native CLI/TUI compatibility check.

Create two repositories with committed files and explicit `.wct.yaml` files.
Configure `base_branch: main`, a disposable `worktree_dir`, and
`tmux.windows: [{ name: main }]`. Register both under the isolated home with
`wct projects add`, create a linked Workspace with `wct open other --no-attach`,
and start main Workspaces with `wct up --no-attach`. Explicit tmux configuration
is necessary: a configured repository without it is an observation fixture with
no Workspace Sessions. Add one native, unowned session to exercise navigation
outside Workspace ownership. Save session IDs and pane PIDs before mutations.

## Workspace and repository custody

Use actual CLI processes and an actual Ink TUI in separate PTYs. Service-only
callers can supplement this evidence but cannot demonstrate visible TUI waiting.
Gate scripts with files in the disposable root rather than fixed delays. Put an
upper bound on the harness's wait, retain diagnostics on timeout, and explicitly
release or stop each known fixture child during cleanup.

| Scenario                     | Procedure and required observation                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conflicting operations       | Hold `open other --no-attach` in a setup command. In the TUI select that Workspace, request Stop and confirm. Capture the visible Waiting row and cancellation hint. Run Start on another Workspace while the owner remains held. Escape must cancel only the waiter; release the owner and verify normal completion and no Stop script execution. Repeat with a CLI waiter interrupted while acquiring custody.                                                            |
| Acknowledged background work | A setup command starts a known workload with stdin/stdout/stderr detached and records its PID; a following setup command records completion. Verify successful Open, a live workload and an available reservation. Separately gate a following step and confirm the encompassing operation remains busy after the earlier command completed. Stop the recorded workload explicitly.                                                                                         |
| Ambiguous command loss       | In a fixture-only Git wrapper, gate `worktree add` after launching a separately recorded writer with detached output. Kill the invoking CLI during that command. Observe a free kernel lock with `outcome-unknown` in both custody namespaces while the known writer still exists. Conflicting commands must fail without replay. Release the writer into a disposable marker, collect it and stop any remaining known fixture processes before reconciliation.             |
| Exact recovery               | Inspect Workspace and repository scopes separately. Reject reconciliation while live custody exists and with an incorrect generation. Release the exact Workspace reservation and show that the repository reservation remains fenced; then reconcile that exact reservation. Acquire a newer reservation and prove that the old operation/generation cannot release it, including after that newer owner exits ambiguously. Never delete journal or lock files to recover. |
| Canonical repository scope   | Compare `operations inspect-repository --repo` through the main checkout, a linked checkout and a symlink. They must identify the same actual Git common directory. Retain both scope identities and exact operation/generation pairs in the record.                                                                                                                                                                                                                        |
| Self-session shutdown        | Run Close inside its own real tmux pane with a gated down script. Capture the announced saved-result path outside the checkout, disappearance of that session, the adopted worker PID/generation and busy reservation while cleanup remains held. Release it and verify removal, durable result, finalized custody and worker exit. A parseable result alone does not establish clean completion.                                                                           |

Use the [recovery commands and ownership contract](workspace-operations.md#cross-process-ownership-and-recovery)
for exact CLI arguments. Ready/Start/Adopted failure windows require recorded IPC
and exit evidence or explicitly attributed regression evidence. Do not infer
every transfer boundary from a successful self-session run, or interpret a dead
PID as proof that all descendants are gone.

## Actual browser and native interactions

Start the foreground `wct browser` command in an existing Workspace. Use its
one-use bootstrap URL in a real browser, then open a second tab on the same
origin. Keep links, cookies and tickets out of published logs. Record the browser
engine/version, viewport, xterm DOM or visual evidence, PTY grids, session IDs,
attachment generations and stream IDs. A fixture DOM or mocked xterm is separate
regression evidence. A raw WebSocket connector establishes transport behavior,
not browser rendering. Record screenshot or browser-tool failures explicitly.

Keep a native tmux attachment and actual TUI running alongside both tabs.
Check the [documented policies](browser-terminal.md) without changing them:

1. Confirm three live tmux clients but only the unmanaged client in native
   observation. Repeat native selection with zero and two unmanaged clients.
2. Select the same Workspace in both tabs, then different Workspaces. Verify the
   other attachment's session ID stays unchanged. Change filter, expansion and
   width independently. Retain an old row, rerender, and invoke it: it must not
   switch the attachment.
3. Type through real xterm input. Verify output isolation across different
   Workspaces, and shared current window, active pane and layout when viewing the
   same session. Create windows with an explicit disposable working directory.
   Record the configured window sizing option before and after fitting.
4. Navigate with native tmux keys, including a session change followed by text in
   one raw burst. Confirm the text reaches the selected session and the sidebar
   follows. Navigate to the unowned session and verify its native label and
   cleared Workspace selection. Exercise cumulative ACKs across that change
   against the recorded target of each sent frame.
5. Resize a tab and its sidebar. Exercise selection and resize while input or
   output is pending; record ordered watermarks/replies, actual input drain and
   renderer consumption. An unsettled or timed-out control must recover or fail
   safely rather than mutate a replacement target.
6. Lose the WebSocket while the owned tmux client still exists. Delay recovery
   long enough to emit a unique marker while disconnected. Keep the grid exactly
   unchanged. Verify a new renderer, attachment and stream, a fresh visible
   redraw containing the marker and no old byte replay. Invoking captured old
   callbacks must not send input, ACKs or controls to either stream. Distinguish
   this from externally detaching the tmux client: absent final target evidence
   can correctly stop recovery.
7. Measure accepted idle input and actual Bun drain callbacks. Attempt cumulative
   exhaustion and resize/switch recovery. If real drains replenish the budget
   during the attempt, report exhaustion as unobserved; do not manufacture credit
   or claim that crossing 256 KiB proves the non-draining case. Fault-injected
   drain behavior must be labelled separately from the native runtime.
8. Reject unauthenticated creation, missing/null/foreign Origin, alternate Host,
   consumed/expired tickets and stale attachment/stream controls. Withhold ACKs
   to exercise renderer timeout and bounded output. Place a healthy consumer on
   a different Workspace to measure isolation. A fast output burst can saturate
   every viewer of that same session independently. A connector discarding frames
   without ACKs is not evidence for a socket that stops reading altogether.
9. Initiate Stop externally while both tabs and a native client are attached to
   its session. Confirm every relevant attachment reacts, unrelated sessions
   remain live and recovery never selects tmux's fallback or a new session under
   the same name. Repeat with Close on a linked Workspace. Capture connected
   preconditions so already-disconnected clients are not counted as coverage.
10. Close tabs and interrupt the foreground endpoint. Confirm owned clients and
    child callbacks settle, attachment slots are not reused early, and unrelated
    pane PIDs and workloads remain live. Stop only explicitly recorded fixture
    sessions/processes; cleanup must never issue a global `tmux kill-server`.

Run the live PTY/attachment procedure separately on Linux and Darwin when
available. Record the actual Linux distribution, kernel/architecture, Bun build,
server capability and source preparation. A container is a validation environment,
not evidence of a product need for a second host. Capability skips and an existing
green Ubuntu job do not establish the skipped live path.

## Duplicate-observation measurement

Measure actual simultaneous TUI processes at explicit client counts, such as
one, two and four, against the same isolated registry. Include multiple repository
sizes, worktrees, tracked/modified/untracked file counts and live sessions/panes.
Record no-session baselines separately. Keep GitHub/network activity and shell
startup costs explicit. Use warmup and multiple polling periods, retain startup
and steady-state windows separately, and repeat trials when estimating variance.

Record each real Git/tmux/process-inspection invocation with caller PID, arguments,
start/completion, wall and CPU time where available. Count the timing wrapper's
own processes separately. Sample TUI CPU time and RSS; repeat an unwrapped
baseline to expose instrumentation overhead. Short-command CPU values rounded
to zero are not zero cost. Summed RSS double-counts shared pages and is not unique
physical memory. Subprocess wall times overlap and are not end-to-end latency.
Measure full repository/session/client observation-call latency separately with
independent native service clients, identifying these as service callers rather
than rendered TUI latency. Do not attribute all TUI memory or rendering CPU to
duplicate scans.

For browser comparison, count catalog work per foreground endpoint, independently
of per-attachment verification and native TUI scans. Concurrent sidebar requests
can share the existing endpoint-wide catalog query/cache; several tabs do not
imply several complete repository scans. Retain revisions and process attribution
to distinguish a cache hit from a fresh shared query.

Publish raw samples, methodology, exact run identities, measured rates, latency,
CPU/RSS limits and uncertainty. Ask the maintainer whether the measured cost is
material for their workflow. Scan counts alone do not authorize a daemon. Keep
#345 open/no-go if technical evidence or the need decision is still missing;
implementation ticket closure and CI cannot substitute for either input.

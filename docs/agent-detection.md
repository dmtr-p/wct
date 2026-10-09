# Foreground agent detection

The TUI automatically observes Claude Code and Codex in registered Workspace
sessions on the tmux server selected by the current environment. Detection is
ephemeral. It never sends pane input, changes layouts, installs hooks, or stores
terminal text, titles, or arguments in SQLite or logs.

## Identification and states

Exact foreground executable names `claude`, `claude-code`, and `codex` establish
identity first. Process inspection verifies foreground ownership and tracks PID,
start time, and process group. The initial `pane_pid` is not treated as the agent.
Stopped/background jobs and shell return clear the foreground-agent observation.
Independent recognized agents in the same foreground group remain unresolved;
tmux's command name cannot disambiguate them.

For generic `node` and `bun` processes, only these official package entrypoints
are recognized from foreground arguments:

- `node_modules/@anthropic-ai/claude-code/cli.js`
- `node_modules/@openai/codex/bin/codex.js`

Supported runtime flags are `--no-warnings`, `--enable-source-maps`, and `--`.
Eval strings, arbitrary argument mentions, unsupported wrapper shapes, nested
tmux, and agents hidden behind SSH/container/VM wrappers remain unresolved.
macOS `ps` arguments cannot reliably preserve argument boundaries; argument
listings containing quotes/escapes and space-containing entrypoints remain unresolved. Linux reads bounded
`/proc/<pid>/cmdline` data. Argument caches expire after one second and arguments
are rechecked after screen capture.
Missing wrapper arguments retain a prior observation only while its exact
foreground generation remains present, marking it stale and expiring it after
five seconds. They do not promote a native child to a replacement generation.
Verified argument or process replacements still clear obsolete observations.
Revalidation applies to retained observations even if argument failures skipped
their captures, including cycles where every pane skipped capture. A recovered
identity check without a fresh screen does not renew the retained evidence.

Screen rules adapt the Herdr manifests pinned in issue #202. Agent-specific
priorities are preserved. In particular, an active title spinner can outrank a
screen approval signal; there is no universal blocked-before-working rule.
Arbitrary titles and hidden progress do not imply readiness. A blocked title
requires corroborating live controls. Composer-only screens do not prove idle;
Claude uses its prompt box and Codex also requires a readiness footer. A populated
Codex composer also supports the passive status line with a known GPT/o-series
model and usage/context percentage, separated from the draft by a blank row.
Codex 0.162.0 suppresses its shortcuts hint for drafts and only shows that passive
status line when the draft has no running task; see its
[footer implementation](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/tui/src/bottom_pane/footer.rs).
Active-turn and approval evidence retain priority. Other custom footer layouts
remain unknown. English
controls and known spinner glyphs are covered; unrecognized localized UIs remain
unknown. See `THIRD_PARTY_NOTICES.md` for upstream attribution and adaptations.
Codex screen activity requires the timer row's live interrupt control; elapsed
time in a response alone does not prove activity. Known composer footers bound
the entire editable draft, including blank paragraphs, so quoted approval and
update messages cannot become live controls or corroborate a blocked title.
Claude's editable prompt-box body is likewise excluded from screen rules while
its borders and readiness marker remain available. Live activity outside the
box, title spinners, and approval-dialog controls retain their priorities.
A recognized composer also excludes preceding completed-response text from
blocker rules, so quoted workflow, permission, and directory-trust dialogs do
not establish live blockers or corroborate a blocked title. Activity rules
still inspect live rows above the composer; genuine dialogs remain detectable
when their controls replace the composer or appear in its footer.

| Observation | Behavior |
| --- | --- |
| Verified active-turn evidence | Working immediately |
| Verified approval/question controls | Blocked according to the agent's priorities |
| Known readiness evidence | Idle; weaker working-to-idle evidence needs two consecutive observations |
| Startup, unmatched UI, or unsupported controls | Unknown |
| Recognized transcript/menu view | Retain the last valid state as stale, without renewing its timestamp |
| Failed capture/process/discovery | Explicit stale/unavailable observation; isolate pane failures |
| Five seconds without fresh evidence | Unknown/unavailable; prior state is kept separately for diagnostics |
| Exit, suspension, foreground replacement, pane removal, server replacement | Clear obsolete foreground state |
| Process replacement during capture | Discard the late result |
| Resize or conflicting title evidence during capture | Mark the sample unavailable and retry |

The expiry timer continues while a slow observation cycle is in flight. PID and
start-time observations cannot distinguish every possible in-place exec of an
identical executable; runtime entrypoints are re-read to avoid indefinitely
caching a replaced script.
Confirmed tmux pane removal, death, server replacement, or foreground metadata
replacement clears obsolete observations even if the process recheck fails.

After an observed process replacement, unchanged old screen/title evidence is
suppressed using ephemeral fingerprints. Each source becomes usable when it
changes. A relaunch whose entire UI remains byte-for-byte identical may stay
unknown until fresh visible evidence appears; old text is not evidence that the
new process is ready or blocked. Fingerprints are cleared when a pane/server
disappears and are never persisted.

## Observation and presentation

A TUI-owned loop targets one second between observation starts. It batches
server-wide pane metadata and host process metadata, captures only recognized
agent panes, deduplicates linked panes, and revalidates generation afterward.
Requests are coalesced; cycles and captures for the same pane do not overlap.
Unregistration changes are rejected before an obsolete result can publish.
Unmount interrupts scoped process operations and clears timers.

There are at most four concurrent captures. Commands have a one-second timeout;
capture output is limited to 256 KiB per stream. Metadata/process/argument reads
also have bounded output. Slow large installations may exceed the target cadence
without increasing concurrency or overlapping cycles.

Capture uses the live base grid: `capture-pane -p -t <pane-id>`. It preserves
physical line boundaries and does not request scrollback, joined lines, the
saved alternate grid, or the user's copy-mode screen. There is no terminal
emulator or control-mode client. Attachment semantics remain unchanged.

The implementation targets tmux 3.2 core metadata/capture on macOS and Linux.
Optional `pane_pb_state` values are capability-checked against the connected
server: missing fields leave title/screen rules operational. Progress is not
used alone to classify state. Older-version and Linux release validation is
still pending below.

Pane rows retain their existing actions and IDs. Workspace counts use Workspace
Identity and include collapsed/detached sessions. Counts appear in blocked,
working, idle, unknown order; retained counts explicitly say stale. Each linked
pane counts once per Workspace. Rows remain single-line with width-aware
truncation. Only semantic/membership/freshness changes update presentation.
The existing full registry/git/PR refresh remains on its existing cadence.

## Validation record and release gates

Implementation checks on 2026-10-09:

- Type checking completed successfully. Repository harness hooks own tests and
  lint; neither was invoked manually.
- Read-only local macOS observation identified four foreground agents across
  nine panes. Three cycles took 85, 82, and 81 ms. Results included Claude idle,
  Codex idle, Codex working, and one conservative Codex unknown classification.
  This verifies input plumbing on this host, not classifier accuracy across
  transitions or a scaling guarantee.
- No input, approval, agent configuration, layout, or lifecycle changes were
  made to the observed panes. Transcript/title/argv payloads were not retained.
- The connected server reported tmux **3.7c** (the installed client reported
  3.8). Optional progress metadata was available. The running agent binary
  versions were not established. This smoke check does not complete the
  interactive tmux 3.7 or compatibility-floor validation.

The following checks must pass before calling the feature release-ready. Record
versions, expected/observed states, latency, and results without saving user
transcripts. Synthetic tests are not substitutes for these observations.

- [ ] Actual running versions of both agents: idle → working → blocked → resumed
  → idle; approval and question variants; disabled title updates; startup/update
  dialogs; transcript/menu views; reduced motion and supported language settings.
- [ ] Narrow terminals, wrapped controls, blank rows, resize during a turn, and
  historical transcript text that resembles current controls.
- [ ] macOS and Linux: official runtime wrappers, denied inspection, exit/relaunch,
  process replacement, Ctrl-Z/fg, shell return, and unrelated background jobs.
- [ ] tmux 3.2 and 3.7: alternate screens, copy-mode scrolling, detached sessions,
  linked windows, removed panes, server restart, and absent progress fields.
- [ ] One, fifteen, and larger numbers of real agent panes: cycle cost, semantic
  update latency, UI responsiveness, cancellation, and timeout behavior.
- [ ] Existing attachment/client discovery, pane jump/zoom/kill, keyboard
  selection, viewport scrolling, and mouse hit-testing in the live TUI.

V1 adds no database migration, CLI JSON change, daemon, notifications, global
hooks, agent launch/resume management, or multi-server aggregation.

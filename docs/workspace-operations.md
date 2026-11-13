# Workspace Operations

CLI commands and TUI actions share Workspace lifecycle services. See the
[domain glossary](../CONTEXT.md#workspace-operation) for Workspace terminology.

## Cross-process ownership and recovery

Open, Start, Stop, Close and removal-only retries acquire host-local custody for
the canonical Main Repository and exact branch. The operation keeps that lease
across copying, all commands, tmux changes and removal until it finishes or
transfers custody to the shutdown worker. Independent Workspaces can progress
concurrently. In-process TUI duplicate-action claims remain in effect.

A conflicting caller displays a waiting phase. Ctrl-C cancels a CLI wait;
Escape on the selected TUI Workspace cancels its wait and restores its lifecycle
presentation. Quitting the TUI cancels waiting actions while active mutations
drain. Cancellation never interrupts the existing owner. JSON diagnostics go to
stderr and stdout retains the ordinary result envelope. After acquisition,
the service rechecks canonical identity, checkout and Git registration evidence,
configuration and the verified session generation. A changed destructive target
requires a fresh confirmation. Direct CLI scripts retain the invoking environment.

Acknowledged command completion permits intentional background workloads to
continue, while the operation still holds custody between commands. Known exits
retain the setup/down failure policy below. Interrupted or uncertain completion,
including an optional command, stops later mutations and leaves durable fencing.
An ambiguous crash cannot be cleared by a timeout, PID check or free kernel lock.

Inspect custody from the owning machine and user account, even when the checkout
is missing:

```sh
wct operations inspect feature --repo /path/to/main-repository
wct operations inspect feature --repo /path/to/main-repository --json
```

Inspection reports `available`, `busy` or `outcome-unknown`, the canonical target,
and the exact operation ID and ownership generation when reserved. For an unknown
outcome, inspect potentially surviving work and side effects before explicitly
releasing that exact reservation:

```sh
wct operations reconcile feature --repo /path/to/main-repository \
  --operation OPERATION_ID --generation GENERATION \
  --acknowledge-uncertain-side-effects --reason 'Inspected surviving work and side effects'
```

Reconciliation uses the coordination service's compare-and-swap, rejects live or
newer ownership, records the inspection reason and never executes scripts. Never
delete lock files or journals. See [Workspace coordination](workspace-coordination.md)
for durability and platform limits.

Shared Git configuration transactions, worktree creation and removal use a
durable repository mutation lease, always after Workspace custody when part of a lifecycle.
Only the Git operation holds it; scripts, prompts and worker handoff waits do not.
Fetch uses Git's own ref/pack locks and reports competing Git failures normally.

## Open

`base_branch` supplies the starting ref for new branches when `wct open` has no
`--base`; without it, new branches start at HEAD. The TUI prefills its new-branch
base field with this value when configured. Before creating a branch, Open runs
`git fetch --all` and then validates the base ref, so remote-tracking bases such
as `upstream/main` use the fetched commit. A fetch failure stops creation.
Fetching leaves local branches and HEAD at their current commits. Reopening a
worktree or using `--existing` skips this fetch; PR checkouts fetch their PR
branch separately.

`push_remote` must name an existing Git remote and sets
`branch.<name>.pushRemote` in local Git configuration without changing the
branch's upstream. Git's usual push rules still apply. These defaults do not
apply to `--existing`, PR checkouts, or branches in reused worktrees. Both keys
are optional and can also be set in `~/.wct.yaml`; project values take precedence.

Push-remote intent is stored in branch-specific local Git configuration before
branch creation. If applying the setting fails after creating the worktree,
reopening it retries the original value before setup commands run, even if the
YAML default has changed. Successfully storing the push remote clears the intent,
so later opens preserve manual changes. Creation failure before the branch
exists also clears the intent.

## Copying local files

CLI and TUI Open copy files from the main repository before running setup. When
creating a worktree, the first available copy source wins:

1. The selected profile's `copy` list (automatic or explicit selection).
2. The project `.wct.yaml`'s `copy` list.
3. The main repository's root `.worktreeinclude`.
4. The global `~/.wct.yaml`'s `copy` list.

A project or selected profile `copy: []` disables copying. An existing empty,
comments-only, or no-match `.worktreeinclude` also overrides global copying.
A missing include file falls through to global configuration. YAML copy lists
support file paths, directory paths ending in `/`, and `Bun.Glob` patterns,
relative to the repository root. A leading `!` is matched literally rather than
negating the pattern. Entries select from Git's ignored-file list without a
separate filesystem walk. Missing files and ineligible matches are skipped. A
selected source that disappears before copying is reported as
`source_not_found` and fails Open. Use `.worktreeinclude` for gitignore-style
`!` exclusions.

All copy sources select only **untracked, gitignored regular files**. Git's
repository ignore files, `.git/info/exclude`, and global ignore configuration
all count. Tracked files (even those matching ignore rules), nonignored files,
symlinks, and Git metadata are excluded. For example, if these files are
gitignored, this root `.worktreeinclude` copies them:

```gitignore
# Local configuration
.env
.env.local
config/secrets.json
```

Use gitignore pattern syntax: blank lines and `#` comments, backslash escapes
(such as `\#name` and `\!name`), `*`, `?`, character classes, and `**`. A leading
`/` anchors a pattern at the repository root; a trailing `/` selects a directory's
files. Rules run in order: positive rules include files, `!` rules exclude them,
and a later positive rule can include them again. Overlapping matches copy each
file once. Only the root include file is read.

In `.worktreeinclude`, leading `**/` has a restriction inside directories ignored
as a whole: it reaches files only when the ignored directory matches the pattern
or the first name after `**/` occurs in that directory's path. If `.gitignore`
contains `vendor/`, `**/config.json` does not reach `vendor/config.json` or
`vendor/nested/config.json`; use `vendor/**/config.json`. With `.claude/` ignored,
`**/.claude/skills/*.md` reaches `.claude/skills/example.md` because `.claude` is
in the ignored directory's path. If `outer/` is ignored as a whole, use
`outer/**/.claude/skills/*.md` to reach skills beneath it. YAML copy globs do not
have this restriction.

The include source applies to newly created worktrees, including new
checkouts of existing branches. If initial include resolution or copying fails,
retrying Open uses the current configuration and include rules before setup.
After successful copy processing, reopening skips the include source. YAML copy
lists run on every Open and can overwrite previously copied files.

Copying uses bounded memory. Existing targets keep their permissions; new targets
use 0666 filtered by the process umask. Source permissions and timestamps are not
copied. Paths that refer to the same file succeed without rewriting it.

`wct up` does not copy files.
Unreadable include files, Git discovery failures, and copy failures stop Open
before setup; empty selections skip copying.

The include-copy retry marker lives in worktree-local Git metadata and is
cleared after successful processing, including an explicit YAML override or an
empty selection.

## Setup

Open runs `setup` commands sequentially from `work_dir` after copying files and
before starting tmux. Every command is attempted, including after an earlier
command fails. Setup runs again when reopening an existing worktree, so commands
should be safe to repeat. A project or profile `setup` list replaces its inherited
list; `setup: []` disables inherited commands. `wct up` does not run setup.

Required and optional setup failures are recorded as warnings in the Open result
and reported by the CLI and TUI. They do not fail Open or prevent it from
attempting tmux startup when configured. `optional: true` marks a failure as
optional in the warning and command result. JSON callers can inspect
`data.workspace.attempts.setup` and `data.workspace.warnings` in the
`open --json` success envelope for command results and failures.

## Tmux sessions

New sessions use `<sanitized-checkout-basename>-<identity-hash>`. The suffix is
the first ten lowercase hexadecimal characters of SHA-256 over the Workspace
Identity Key: canonical Main Repository path, NUL, and the exact branch name.
Canonical paths resolve symlinks, including existing ancestors of deleted
checkouts. Session names remain readable and distinguish repositories or
branches whose readable prefixes collide.

The session-scoped `WCT_WORKSPACE_ID` environment entry stores the full identity
in Base64. A name or hash alone never establishes ownership. Open, Start,
Stop, Close, switching, and CLI/TUI discovery share ownership resolution.
Pane and agent discovery attributes only verified sessions to Workspaces.
Recorded repository, branch, and checkout fields must agree with the target
even when the full identity matches. Failed ownership inspection blocks
lifecycle actions; observation can show the session without attributing it to
a Workspace.

Basename-only sessions can be reused in place when their session-scoped
`WCT_MAIN_DIR`, `WCT_BRANCH`, and `WCT_WORKTREE_DIR` match the canonical target.
Resolution tags these verified legacy sessions with the full identity. A pane's
working directory or inherited global environment is insufficient evidence.
Missing or conflicting ownership and multiple owned sessions produce a conflict
diagnostic. Inspect the sessions and stop or rename conflicting sessions manually
before retrying. Stop and Close stop before down scripts or worktree removal on
an ownership conflict. A legacy session verified as belonging to another
repository or checkout does not interfere. An ambiguous legacy name can coexist
with an unambiguous, verified session with the new name.

Session mutations use the verified tmux session ID. Construction rollback only
targets the ID returned by successful creation. A failed acquisition never
authorizes cleanup of an existing session. Shutdown carries the resolved
Workspace identity and session ID/server generation to its detached worker and
revalidates them before stopping the session. A replacement requires retrying
the operation. When HEAD is detached, shutdown can identify the session through
its canonical repository and checkout paths and verify its recorded branch
identity.

## Shutdown

Both `wct down` and `wct close` run `down` scripts after stopping the tmux session,
including when no session exists. Scripts run sequentially from `work_dir`;
every script is attempted. A required failure makes the operation fail and
keeps the worktree, including with `close --force`. Optional failures produce
warnings and allow removal.

`up`, `down`, and `close` resolve the checkout root even when invoked from a
subdirectory, so session names, `work_dir`, and `WCT_WORKTREE_DIR` refer to that
checkout.

When shutdown stops the tmux session containing the invoking pane, an independent
Bun runner finishes cleanup after that pane disappears. Human output prints the
path to its saved JSON result before handing off. `close --yes` authorizes the
worker's force-removal retry; without `--yes` or `--force`, a dirty worktree
remains and the saved result reports `blocked_by_changes`.

Shutdown reads the main repository's current configuration and automatically
selects the first profile matching the current branch. Use
`wct down --profile <name>` or `wct close <branch> --profile <name>` (`-P`) to
override it. The TUI uses automatic matching. The profile selected at startup
is not remembered. Detached HEAD uses the base configuration unless a profile
is specified, with an empty `WCT_BRANCH`.

A project or profile `down` list replaces its inherited list; `down: []` disables
inherited scripts. Scripts run again on separate down/close calls, so make
cleanup safe to repeat. The CLI's internal force-removal retry skips scripts
already run by that close action. Removal retries resolve the main repository
from retained canonical evidence because cleanup scripts may delete the invoking
directory. TUI force-removal retries also retain the blocked Close result and
skip completed scripts. Retries reacquire custody and reject replaced checkout,
registration, configuration or session targets; they cannot bypass crash fencing.
If a registered worktree directory has already been deleted, close skips scripts
and cleans up the Git registration.

The detached worker uses configuration and environment resolved before handoff.
Its saved outcome is staged outside the checkout even when a project-local
temporary directory or symlink points into it.

The worker adopts inherited descriptor-4 custody using Ready/Start/Adopted before
mutating and provides its adopted lease to process execution. It never reacquires
its own lock. Progress and result messages share IPC with the dedicated custody
protocol. The worker retains ownership through durable outcome publication;
loss of an adoption acknowledgement after Start cannot restore caller authority.
Successful worker completion additionally requires durable result publication,
custody finalization and clean exit. A parseable saved result from a failed or
killed worker is insufficient proof of success. See
[repository recovery](workspace-coordination.md#repository-mutation-custody) for
separately fenced Git mutation transactions and their explicit recovery CLI.

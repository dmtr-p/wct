# Workspace Operations

CLI commands and TUI actions share Workspace lifecycle services. See the
[domain glossary](../CONTEXT.md#workspace-operation) for Workspace terminology.

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
support file paths, directory paths ending in `/`, and Bun globs. Missing files
and ineligible matches are skipped.

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
`wct up` does not copy files.
Unreadable include files, Git discovery failures, and copy failures stop Open
before setup; empty selections skip copying.

The include-copy retry marker lives in worktree-local Git metadata and is
cleared after successful processing, including an explicit YAML override or an
empty selection.

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
from the worktree root because cleanup scripts may delete the invoking directory.
If a registered worktree directory has already been deleted, close skips scripts
and cleans up the Git registration.

The detached worker uses configuration and environment resolved before handoff.
Its saved outcome is staged outside the checkout even when a project-local
temporary directory or symlink points into it.

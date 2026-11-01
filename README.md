# wct

Git worktree workflow automation CLI. Quickly create isolated development environments for different branches with pre-configured tooling and tmux sessions.

## Usage

```bash
wct open <branch>       # Create worktree, run setup, and start tmux session
wct up                  # Start tmux session for the containing checkout
wct down                # Stop tmux session and run down scripts
wct close <branch...>   # Stop tmux, run down scripts, and remove worktrees
wct list                # Show worktrees with tmux, changes, and sync status
wct switch <branch>     # Switch to another worktree's tmux session
wct cd <branch>         # Open a shell in a worktree directory
wct tui                 # Interactive TUI sidebar for managing worktrees
wct init                # Generate a starter .wct.yaml config file
wct projects add [path] [--name NAME]  # Add a repo to the project registry
wct projects remove [path]             # Remove a repo from the project registry
wct projects list                      # List registered projects
```

`open`, `up`, `down`, and `close` accept `--profile <name>` / `-P <name>` to select a named config profile (see [Config Profiles](#config-profiles)).

`wct open --pr <number-or-url>` opens a worktree for a GitHub PR without requiring
a branch argument. `up` and `down` accept `--path <path>` or `--branch <name>`
to target another checkout. `wct list --short` prints branch names only.

### JSON and terminal output

`open`, `up`, `down`, `close`, `list`, and `projects` support the global
`--json` flag. Success envelopes use stdout; error envelopes use stderr.
JSON output has no color or bold styling. `close --json` returns a structured
aborted result unless `--yes` is supplied; it never opens a confirmation prompt.

When shutdown destroys the invoking tmux pane, the caller cannot emit its
final envelope. The detached runner saves the outcome in `result.json`.

Human-readable logs use styling when their destination stream is a terminal
by default. `FORCE_COLOR=1` also enables styling on redirected streams.
A nonempty `NO_COLOR` or `TERM=dumb` disables color and bold styling,
including when `FORCE_COLOR` is set.

## Installation

### Homebrew (recommended)

```bash
brew install dmtr-p/tools/wct
```

Shell completions for bash, zsh, and fish are installed automatically.

### mise

```bash
mise use -g github:dmtr-p/wct
```

### Manual download

Download the binary for your platform from [Releases](https://github.com/dmtr-p/wct/releases/latest):

```bash
# macOS (Apple Silicon)
curl -fsSL https://github.com/dmtr-p/wct/releases/latest/download/wct-darwin-arm64 -o wct

# macOS (Intel)
curl -fsSL https://github.com/dmtr-p/wct/releases/latest/download/wct-darwin-x64 -o wct

# Linux (x64)
curl -fsSL https://github.com/dmtr-p/wct/releases/latest/download/wct-linux-x64 -o wct

# Linux (ARM64)
curl -fsSL https://github.com/dmtr-p/wct/releases/latest/download/wct-linux-arm64 -o wct
```

```bash
chmod +x wct
sudo mv wct /usr/local/bin/wct
```

Verify installation:

```bash
wct --version
```

### Shell completions (manual install)

Profile suggestions use the main repository's configuration, including global defaults, from nested directories and linked worktrees. Invalid configuration produces no profile suggestions.

When installed via Homebrew, completions are set up automatically. For manual installs:

**Bash** — add to `~/.bashrc`:

```bash
eval "$(wct --completions bash)"
```

**Zsh** — add to `~/.zshrc`:

```bash
eval "$(wct --completions zsh)"
```

**Fish** — run once:

```bash
wct --completions fish > ~/.config/fish/completions/wct.fish
```

## Configuration

Run `wct init` from your project root to generate a starter `.wct.yaml` in the current directory. Here's an annotated example:

```yaml
version: 1

# Base directory for worktrees (relative to project root, supports ~ expansion)
worktree_dir: ".."

# Prefix for new worktree directories ("project-branch")
# Defaults to the git repo directory name
project_name: "myapp"

# Defaults for newly created branches
base_branch: "upstream/main"
push_remote: "origin"

# Working directory for setup/down commands and tmux panes (relative to each worktree)
work_dir: "apps/web"

# Gitignored files/directories to copy from the main repository during Open
copy:
  - .env
  - .env.local

# Commands to run during open, before starting tmux (in order)
setup:
  - name: "Install dependencies"
    command: "bun install"
  - name: "Generate types"
    command: "bun run codegen"
    optional: true # report failures as optional warnings

# Commands to run after stopping tmux, before removing the worktree (in order)
down:
  - name: "Stop containers"
    command: "docker compose down"
  - name: "Clean temporary resources"
    command: "./cleanup.sh"
    optional: true

tmux:
  windows:
    - name: "dev"
      split: "horizontal" # or "vertical"
      panes:
        - command: "bun run dev"
        - {} # empty shell
    - name: "shell"

# Config profiles — override sections per branch pattern
profiles:
  ci:
    match: "ci/*"
    work_dir: "apps/worker"
    setup:
      - name: "Install (CI)"
        command: "bun install --frozen-lockfile"
    tmux:
      windows:
        - name: "logs"
          panes:
            - command: "tail -f ci.log"
  hotfix:
    match: ["hotfix/*", "fix/*"]
    copy:
      - .env
      - .env.production
```

`base_branch` supplies the default starting ref for new branches, and
`push_remote` selects their Git push remote. These defaults apply to new
branches created by Open. See [Open behavior](docs/workspace-operations.md#open)
for fetching, overrides, and retry handling.

Tmux window names must match `[A-Za-z][A-Za-z0-9_-]*` and be unique within each `windows` list, including lists in profiles. Names start with an ASCII letter and contain only ASCII letters, digits, underscores, or hyphens, such as `dev`, `CI-logs`, and `test_runner`.

Each pane supports an optional `command`; `{}` opens an empty shell. A pane-level
`name` is accepted as an unknown configuration key and ignored, including in
profiles. It does not name or title the pane.

Environment variables `WCT_WORKTREE_DIR`, `WCT_WORK_DIR`, `WCT_MAIN_DIR`, `WCT_BRANCH`, and `WCT_PROJECT` are available in `setup` and `down` commands and tmux panes. `WCT_WORK_DIR` is the absolute path obtained by resolving `work_dir` against the worktree.

Tmux session names come from the checkout directory's basename, with characters
outside `[A-Za-z0-9_-]` replaced by hyphens. `project_name` determines the prefix for directories
created by Open and the value of `WCT_PROJECT`; it does not rename existing
checkouts or their sessions.

A global config at `~/.wct.yaml` can provide defaults; project-level config takes precedence.

### Copying local files

Open copies untracked, gitignored regular files from the main repository before
setup. The selected profile's `copy` list takes precedence over project
`copy`, the root `.worktreeinclude`, and global `copy`. An explicit empty
project/profile list disables copying. Start (`wct up`) does not copy files.

See [copying local files](docs/workspace-operations.md#copying-local-files) for
include patterns, file eligibility, and retry behavior.

### Setup commands

Open runs `setup` commands before starting tmux. See
[setup behavior](docs/workspace-operations.md#setup) for command ordering,
repeated setup, and failure reporting.

### Down scripts

Both `wct down` and `wct close` run `down` scripts after stopping tmux,
including when no session exists. Required failures preserve the worktree;
optional failures produce warnings and allow removal.

See [shutdown behavior](docs/workspace-operations.md#shutdown) for profile
selection, repeated cleanup, missing worktrees, and shutdown of the invoking
tmux session.

### Config Profiles

Profiles let you override `work_dir`, `copy`, `setup`, `down`, and `tmux` sections based on the branch name. Define profiles under the `profiles:` key in `.wct.yaml`.

Profile names must match `[A-Za-z0-9][A-Za-z0-9._-]*`: start with an ASCII letter or digit, followed by ASCII letters, digits, dots, underscores, or hyphens. For example, `dev`, `ci-linux`, and `team.local` are valid names.

The [configuration example](#configuration) shows `ci` and `hotfix` profiles
with branch patterns and section overrides.

**Auto-matching:** When you run `wct open <branch>`, `wct up`, `wct down`, or `wct close`, profiles are matched against the workspace's branch name using glob patterns in `match`. The first matching profile wins. Only the sections defined in the profile are overridden — everything else falls through to the base config.

During Open, a profile without `copy` uses the [copy-source precedence](#copying-local-files).

**Explicit selection:** Use `--profile <name>` / `-P <name>` with `wct open`, `wct up`, `wct down`, or `wct close` to select a profile by name, bypassing auto-matching. This works even for profiles without a `match` pattern. An unknown name returns a configuration error before lifecycle work begins, including when no profiles are configured.

Use `--profile ""` to select the base configuration without automatic matching.

## TUI

`wct tui` opens an interactive sidebar for registered projects. Repos stay expanded; use `↑`/`↓` to navigate, `→` to show branch details, and `←` to hide them. Multiple branches can remain expanded.

Repository and tmux state refresh every five seconds and on database changes.
See [TUI refresh](docs/tui-refresh.md) for publication and failure behavior.

GitHub PR Associations and the Open modal's PR list use cached discovery with incremental background updates. Manual refresh rebuilds history. See [PR discovery and refresh](docs/pr-refresh.md) for polling, cache reuse, and failure behavior.

Claude Code and Codex foreground agents are detected automatically in Workspace panes, including agents started manually. Pane rows show `idle`, `working`, `blocked`, or `unknown`; Workspace rows show counts, including collapsed and detached Workspaces. Unknown means the current UI could not be classified. Stale observations retain their last state for at most five seconds before becoming unavailable. Detection uses a separate one-second observation loop and does not install agent hooks or save transcripts. See [agent detection behavior and compatibility](docs/agent-detection.md) for supported wrappers and validation requirements.

Register repositories explicitly with `wct projects add` or the TUI's Add Project action. Opening or starting a workspace does not register its repository. `--name` changes the project's display name in the registry; it does not change the configured `project_name`. The TUI's Remove Project action stops the project's sessions, runs down scripts, and removes it from the registry while keeping its worktrees. `wct projects remove` removes registry membership and leaves sessions running.

Text fields support Left/Right, Home/End, Backspace/Delete, and insertion at the visible cursor. Right accepts a selected path completion when the cursor is already at the end. Ghostty's default Command+Left/Right and Command+Backspace bindings send Ctrl+A/E/U; in text fields these move to the start/end and delete from the cursor to the start. The same Ctrl shortcuts work because the terminal sends identical bytes. To send distinct Home/End sequences instead, you can use these optional Ghostty bindings:

```text
keybind = super+arrow_left=csi:H
keybind = super+arrow_right=csi:F
```

These bindings can also be used through tmux when the terminal forwards the sequences.

### Mouse

Mouse support is **on by default**:

- **Wheel** scrolls the worktree viewport one row per tick. The selection stays put and may scroll out of view — the wheel never moves the cursor.
- **Left-click** selects a row.
- **Double-click** expands or collapses a branch, PR details, or PR candidates, or switches to a tmux pane.

Form modals support clicking fields, options, and buttons; focused lists support wheel scrolling and row selection. Confirmation buttons are clickable. Search and the PR actions menu use the keyboard. Set `WCT_DISABLE_MOUSE=1` to disable mouse reporting; any nonempty value disables it.

Hold **Shift** while dragging to use native terminal text selection. If tmux mouse mode conflicts with the TUI, use `WCT_DISABLE_MOUSE=1`.

## Development

To install dependencies:

```bash
bun install
bun run prepare
mise run hooks:install
```

To run:

```bash
bun run src/index.ts
```

Use [Bun](https://bun.com) for development and builds. See
[development tooling](docs/development.md) for dependency preparation, automated
checks, caching, hooks, and editor setup; [testing](docs/testing.md) for service
fixtures and isolation; and [AGENTS.md](AGENTS.md) for repository conventions.

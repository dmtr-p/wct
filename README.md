# wct

Git worktree workflow automation CLI. Quickly create isolated development environments for different branches with pre-configured tooling and tmux sessions.

## Usage

```bash
wct open <branch>       # Create worktree, run setup, and start tmux session
wct up                  # Start tmux session for the containing checkout
wct down                # Stop tmux session and run down scripts
wct close <branch...>   # Stop tmux, run down scripts, and remove worktrees
wct list                # Show worktrees with tmux session status
wct switch <branch>     # Switch to another worktree's tmux session
wct cd <branch>         # Open a shell in a worktree directory
wct tui                 # Interactive TUI sidebar for managing worktrees
wct init                # Generate a starter .wct.yaml config file
wct projects add [path] [--name NAME]  # Add a repo to the project registry
wct projects remove [path]             # Remove a repo from the project registry
wct projects list                      # List registered projects
```

`open`, `up`, `down`, and `close` accept `--profile <name>` / `-P <name>` to select a named config profile (see [Config Profiles](#config-profiles)).

### JSON and terminal output

`open`, `up`, `down`, `close`, `list`, and `projects` support the global
`--json` flag. Success envelopes use stdout; error envelopes use stderr.
JSON output has no color or bold styling. `close --json` returns a structured
aborted result unless `--yes` is supplied; it never opens a confirmation prompt.

When shutdown destroys the invoking tmux pane, the caller cannot emit its
final envelope. The detached runner saves the outcome in `result.json`.

Human-readable logs use styling only when their destination stream is a
terminal. A nonempty `NO_COLOR` disables color and bold styling.

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

Run `wct init` to generate a starter `.wct.yaml` in your project root. Here's an annotated example:

```yaml
version: 1

# Base directory for worktrees (relative to project root, supports ~ expansion)
worktree_dir: ".."

# Configured project name used for worktree and tmux session naming ("project-branch")
# Defaults to the git repo directory name
project_name: "myapp"

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

# Tmux session layout
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

Environment variables `WCT_WORKTREE_DIR`, `WCT_WORK_DIR`, `WCT_MAIN_DIR`, `WCT_BRANCH`, and `WCT_PROJECT` are available in `setup` and `down` commands and tmux panes. `WCT_WORK_DIR` is the absolute path obtained by resolving `work_dir` against the worktree.

A global config at `~/.wct.yaml` can provide defaults; project-level config takes precedence.

### Copying local files

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
as a whole: it reaches files only when the ignored directory matches the pattern or the first
name after `**/` occurs in that directory's path. If `.gitignore` contains
`vendor/`, `**/config.json` does not reach `vendor/config.json` or
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

### Down scripts

Both `wct down` and `wct close` run `down` scripts after stopping the tmux session, including when no session exists. Scripts run sequentially from `work_dir`; every script is attempted. A required failure makes the operation fail and keeps the worktree, including with `close --force`. Optional failures produce warnings and allow removal.

`up`, `down`, and `close` resolve the checkout root even when invoked from a subdirectory, so session names, `work_dir`, and `WCT_WORKTREE_DIR` refer to that checkout.

When shutdown stops the tmux session containing the invoking pane, an independent Bun runner finishes cleanup after that pane disappears. Human output prints the path to its saved JSON result before handing off. `close --yes` authorizes the worker's force-removal retry; without `--yes` or `--force`, a dirty worktree remains and the saved result reports `blocked_by_changes`.

Shutdown reads the main repository's current configuration and automatically selects the first profile matching the current branch. Use `wct down --profile <name>` or `wct close <branch> --profile <name>` (`-P`) to override it. The TUI uses automatic matching. The profile selected at startup is not remembered. Detached HEAD uses the base configuration unless a profile is specified, with an empty `WCT_BRANCH`.

A project or profile `down` list replaces its inherited list; `down: []` disables inherited scripts. Scripts run again on separate down/close calls, so make cleanup safe to repeat. The CLI's internal force-removal retry skips scripts already run by that close action. If a registered worktree directory has already been deleted, close skips scripts and cleans up the git registration.

### Config Profiles

Profiles let you override `work_dir`, `copy`, `setup`, `down`, and `tmux` sections based on the branch name. Define profiles under the `profiles:` key in `.wct.yaml`:

```yaml
profiles:
  ci:
    match: "ci/*"
    setup:
      - name: "Install (CI)"
        command: "bun install --frozen-lockfile"
  hotfix:
    match: ["hotfix/*", "fix/*"]
    copy:
      - .env
      - .env.production
```

**Auto-matching:** When you run `wct open <branch>`, `wct up`, `wct down`, or `wct close`, profiles are matched against the workspace's branch name using glob patterns in `match`. The first matching profile wins. Only the sections defined in the profile are overridden — everything else falls through to the base config.

During Open, a profile without `copy` uses the [copy-source precedence](#copying-local-files).

**Explicit selection:** Use `--profile <name>` / `-P <name>` with `wct open`, `wct up`, `wct down`, or `wct close` to select a profile by name, bypassing auto-matching. This works even for profiles without a `match` pattern.

## TUI

`wct tui` opens an interactive sidebar for registered projects. Repos stay expanded; use `↑`/`↓` to navigate, `→` to show branch details, and `←` to hide them. Multiple branches can remain expanded.

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

Form modals support clicking fields, options, and buttons; focused lists support wheel scrolling and row selection. Confirmation buttons are clickable. Search and the PR actions menu use the keyboard. Set `WCT_DISABLE_MOUSE=1` to disable mouse reporting.

Hold **Shift** while dragging to use native terminal text selection. If tmux mouse mode conflicts with the TUI, use `WCT_DISABLE_MOUSE=1`.

## Development

To install dependencies:

```bash
bun install
bun run prepare
```

To run:

```bash
bun run src/index.ts
```

Use [Bun](https://bun.com) for development and builds. See [AGENTS.md](./AGENTS.md) for repository conventions and automated checks.

`bun run prepare` patches the pinned TypeScript compiler with
[@effect/tsgo](https://github.com/Effect-TS/tsgo). Lifecycle scripts are disabled
in `bunfig.toml`, so run it explicitly after installing dependencies. Worktree
setup and CI include this step. The typecheck reports Effect
diagnostics alongside TypeScript errors. Effect errors and warnings fail the
check, and suggestions remain available in the editor.

For VS Code-based editors, install the TypeScript 7 extension and select the
workspace TypeScript version when prompted. The workspace settings point to
the patched compiler for Effect diagnostics, quick fixes, and refactors.

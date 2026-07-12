# wct

Git worktree workflow automation CLI. Quickly create isolated development environments for different branches with pre-configured tooling and tmux sessions.

## Usage

```bash
wct open <branch>       # Create worktree, run setup, and start tmux session
wct up                  # Start tmux session in current directory
wct down                # Kill tmux session for current directory
wct close <branch...>   # Kill tmux session and remove one or more worktrees
wct list                # Show active worktrees with tmux session status
wct switch <branch>     # Switch to another worktree's tmux session
wct cd <branch>         # Open a shell in a worktree directory
wct tui                 # Interactive TUI sidebar for managing worktrees
wct init                # Generate a starter .wct.yaml config file
wct projects add [path] [--name NAME]  # Add a repo to the project registry
wct projects remove [path]             # Remove a repo from the project registry
wct projects list                      # List registered projects
```

Both `open` and `up` accept `--profile <name>` / `-P <name>` to select a named config profile (see [Config Profiles](#config-profiles)).

## Installation

### Homebrew (recommended)

```bash
brew install dmtr-p/tools/wct
```

Shell completions for bash, zsh, and fish are installed automatically.

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

Run `wct init` to generate a starter `.wct.yaml` in your project root. Here's an annotated example covering all options:

```yaml
version: 1

# Base directory for worktrees (relative to project root, supports ~ expansion)
worktree_dir: ".."

# Project name used for tmux session naming ("project-branch")
# Defaults to the git repo directory name
project_name: "myapp"

# Working directory for setup commands and tmux panes (relative to each worktree)
work_dir: "apps/web"

# Files/directories to copy from main repo into new worktrees
copy:
  - .env
  - .env.local

# Commands to run after worktree creation (in order)
setup:
  - name: "Install dependencies"
    command: "bun install"
  - name: "Generate types"
    command: "bun run codegen"
    optional: true # continue even if this fails

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

Environment variables `WCT_WORKTREE_DIR`, `WCT_WORK_DIR`, `WCT_MAIN_DIR`, `WCT_BRANCH`, and `WCT_PROJECT` are available in `setup` commands and tmux panes. `WCT_WORK_DIR` is the absolute path obtained by resolving `work_dir` against the worktree.

A global config at `~/.wct.yaml` can provide defaults; project-level config takes precedence.

### Config Profiles

Profiles let you override `work_dir`, `copy`, `setup`, and `tmux` sections based on the branch name. Define profiles under the `profiles:` key in `.wct.yaml`:

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

**Auto-matching:** When you run `wct open <branch>`, profiles are matched against the branch name using glob patterns in `match`. The first matching profile wins. Only the sections defined in the profile are overridden — everything else falls through to the base config.

**Explicit selection:** Use `--profile <name>` / `-P <name>` with `wct open` or `wct up` to select a profile by name, bypassing auto-matching. This works even for profiles without a `match` pattern.

## TUI

`wct tui` opens an interactive sidebar for registered projects. Repos stay expanded; use `↑`/`↓` to navigate, `→` to show branch details, and `←` to hide them. Multiple branches can remain expanded.

### Mouse

Mouse support is **on by default**:

- **Wheel** scrolls the worktree viewport one row per tick. The selection stays put and may scroll out of view — the wheel never moves the cursor.
- **Left-click** selects a row.
- **Double-click** expands or collapses a branch, opens a PR, or switches to a tmux pane.

Mouse works in the Navigate and Expanded views only; modals and Search are mouse-free. Set `WCT_DISABLE_MOUSE=1` to disable it.

Hold **Shift** while dragging to use native terminal text selection. If tmux mouse mode conflicts with the TUI, use `WCT_DISABLE_MOUSE=1`.

## Development

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run src/index.ts
```

This project was created using `bun init` in bun v1.3.6. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

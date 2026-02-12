# wct

Git worktree workflow automation CLI. Quickly create isolated development environments for different branches with pre-configured tooling, tmux sessions, and IDE integration.

## Usage

```bash
wct open <branch>       # Create worktree, run setup, start tmux session, open IDE
wct up                  # Start tmux session and open IDE in current directory
wct down                # Kill tmux session for current directory
wct close <branch>      # Kill tmux session and remove worktree
wct list                # Show active worktrees with tmux session status
wct init                # Generate a starter .wct.yaml config file
```

## Installation

### Quick Install (Recommended)

Install with a single command (auto-detects your platform):

```bash
curl -fsSL https://raw.githubusercontent.com/dmtr-p/wct/main/install.sh | bash
```

This will download the appropriate binary for your system and install it to `/usr/local/bin/wct`.

To install to a custom location:
```bash
INSTALL_DIR=$HOME/.local/bin curl -fsSL https://raw.githubusercontent.com/dmtr-p/wct/main/install.sh | bash
```

### Manual Installation

Download the binary for your platform from [Releases](https://github.com/dmtr-p/wct/releases/latest):

**macOS (Apple Silicon):**
```bash
curl -fsSL https://github.com/dmtr-p/wct/releases/latest/download/wct-darwin-arm64 -o wct
chmod +x wct
sudo mv wct /usr/local/bin/wct
```

**macOS (Intel):**
```bash
curl -fsSL https://github.com/dmtr-p/wct/releases/latest/download/wct-darwin-x64 -o wct
chmod +x wct
sudo mv wct /usr/local/bin/wct
```

**Linux (x64):**
```bash
curl -fsSL https://github.com/dmtr-p/wct/releases/latest/download/wct-linux-x64 -o wct
chmod +x wct
sudo mv wct /usr/local/bin/wct
```

**Linux (ARM64):**
```bash
curl -fsSL https://github.com/dmtr-p/wct/releases/latest/download/wct-linux-arm64 -o wct
chmod +x wct
sudo mv wct /usr/local/bin/wct
```

Verify installation:
```bash
wct --version
```

### Uninstalling

To remove wct:

```bash
sudo rm /usr/local/bin/wct
```

Or if installed to a custom location:

```bash
rm $INSTALL_DIR/wct
```

## Shell Completions

Tab completions are available for bash, zsh, and fish.

**Bash** — add to `~/.bashrc`:
```bash
eval "$(wct completions bash)"
```

**Zsh** — add to `~/.zshrc`:
```bash
eval "$(wct completions zsh)"
```

**Fish** — run once:
```bash
wct completions fish > ~/.config/fish/completions/wct.fish
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
    optional: true  # continue even if this fails

# IDE configuration
ide:
  name: vscode            # IDE identifier (use "vscode" for VS Code workspace sync)
  command: "code $WCT_WORKTREE_DIR"
  fork_workspace: true    # sync VS Code workspace state to worktree

# Tmux session layout
tmux:
  windows:
    - name: "dev"
      split: "horizontal"  # or "vertical"
      panes:
        - command: "bun run dev"
        - {}  # empty shell
    - name: "shell"
```

Environment variables `WCT_WORKTREE_DIR`, `WCT_MAIN_DIR`, `WCT_BRANCH`, and `WCT_PROJECT` are available in `setup` commands and the `ide.command`.

A global config at `~/.wct.yaml` can provide defaults; project-level config takes precedence.

### VS Code Workspace Sync

When `ide.fork_workspace` is enabled, `wct open` copies VS Code's workspace storage (state and configuration of installed extensions, UI layout, settings) from your main repo into the new worktree. This means each worktree opens with the same extensions, sidebar state, and editor layout as your main workspace — no manual reconfiguration needed. Requires that you've opened the main repo in VS Code at least once. Supported on macOS and Linux.

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

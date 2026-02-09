# wct

Git worktree workflow automation CLI. Quickly create isolated development environments for different branches with pre-configured tooling, tmux sessions, and IDE integration.

## Usage

```bash
wct open <branch>       # Create worktree, run setup, start tmux session, open IDE
wct up                  # Start tmux session and open IDE in current directory
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

## Development

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.6. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

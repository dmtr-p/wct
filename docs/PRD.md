# wct - Product Requirements Document

## Overview

`wct` is a command-line tool that automates the git worktree workflow, enabling developers to quickly spin up isolated development environments for different branches with pre-configured tooling, tmux sessions, and IDE integration.

## Problem Statement

When working on multiple features or bug fixes simultaneously, developers need to:

1. Create git worktrees manually
2. Copy configuration files (.env, CLAUDE.md, etc.) to each worktree
3. Install dependencies in the new directory
4. Set up their terminal environment (tmux sessions, dev servers)
5. Open their IDE in the correct directory

This repetitive process is time-consuming and error-prone. `wct` automates the entire workflow with a single command.

## Target Users

- Developers who work on multiple branches/features concurrently
- Teams using git worktrees for parallel development
- Developers using tmux for terminal session management

---

## Core Features

### Commands

| Command | Description |
|---------|-------------|
| `wct open <branch>` | Create worktree, run setup, start tmux session, open IDE |
| `wct open <branch> -e, --existing` | Same as above but for existing branch (no -b flag) |
| `wct list` | Show active worktrees with tmux session status (attached/detached) |
| `wct init` | Generate a starter `.wct.yaml` config file |

### Configuration

**Config File Locations (in order of precedence):**

1. `.wct.yaml` (project root) - project-specific config
2. `~/.wct.yaml` - global defaults

**Config Schema:**

```yaml
# .wct.yaml
version: 1

# Base directory for worktrees (supports ~ expansion)
worktree_dir: "../worktrees"  # or "~/worktrees/myproject"

# Project name (used for tmux session naming: "project-branch")
project_name: "myapp"

# Files/directories to copy to new worktree
copy:
  - .env
  - .env.local
  - CLAUDE.md
  - .vscode/settings.json

# Commands to run after worktree creation (in order)
setup:
  - name: "Install dependencies"
    command: "bun install"
  - name: "Generate types"
    command: "bun run codegen"
    optional: true  # continue if fails

# IDE command (WCT_WORKTREE_DIR env var available)
ide:
  command: "cursor $WCT_WORKTREE_DIR"
  # or: "code $WCT_WORKTREE_DIR"

# Tmux session configuration
tmux:
  windows:
    - name: "dev"
      layout: "main-vertical"  # even-horizontal, even-vertical, main-horizontal, main-vertical, tiled
      split: "horizontal"      # or "vertical" - direction for pane splits
      panes:
        - command: "bun run dev"
        - command: "bun test --watch"
    - name: "claude"
      command: "claude"
    - name: "shell"  # empty window = just a shell
```

### Workflow (`wct open`)

When user runs `wct open feature-auth`:

1. **Validate** - Check git repo, config exists, branch name valid
2. **Create worktree** - `git worktree add <path> -b <branch>` or checkout existing
3. **Copy files** - Copy configured files from main repo to worktree
4. **Run setup commands** - Execute setup commands in order (with warnings on failure)
5. **Start tmux session** - Create session named `project-branch` with configured layout
6. **Open IDE** - Execute IDE command with worktree path

### Error Handling

- **Continue with warnings**: If a step fails (e.g., dependency install), log a warning and proceed to next steps
- **Clear error messages**: Show which step failed and why
- **Idempotent operations**: Running `wct open` on existing worktree should handle gracefully

### Environment Variables

Available in config commands:

| Variable | Description |
|----------|-------------|
| `WCT_WORKTREE_DIR` | Full path to the worktree directory |
| `WCT_MAIN_DIR` | Full path to the main repository directory |
| `WCT_BRANCH` | Branch name |
| `WCT_PROJECT` | Project name from config |

---

## Technical Specifications

### Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **CLI parsing**: `util.parseArgs` (Bun built-in)
- **Config parsing**: Bun built-in YAML (`Bun.YAML.parse()`)
- **Terminal colors**: `Bun.color` (built-in)
- **Shell execution**: Bun Shell (`Bun.$`)
- **Future**: React Ink for interactive features

### Dependencies

**Runtime: None** - fully powered by Bun built-ins:

- CLI args: `import { parseArgs } from "util"`
- YAML parsing: `Bun.YAML.parse(text)`
- Colors: `Bun.color("red", "ansi")` for terminal output
- Shell: `await Bun.$\`git worktree list\`` for command execution
- File I/O: `Bun.file()`, `Bun.write()`
- Testing: `bun test` (built-in test runner)

**Dev Dependencies:**

- `typescript` - Type checking
- `@biomejs/biome` - Linting and formatting

### File Structure

```
wct/
├── src/
│   ├── index.ts          # Entry point, CLI setup
│   ├── commands/
│   │   ├── open.ts       # wct open command
│   │   ├── list.ts       # wct list command
│   │   └── init.ts       # wct init command
│   ├── config/
│   │   ├── loader.ts     # Load & merge configs
│   │   ├── schema.ts     # Config type definitions
│   │   └── validator.ts  # Config validation
│   ├── services/
│   │   ├── worktree.ts   # Git worktree operations
│   │   ├── copy.ts       # File copying
│   │   ├── setup.ts      # Run setup commands
│   │   ├── tmux.ts       # Tmux session management
│   │   └── ide.ts        # IDE launcher
│   └── utils/
│       └── logger.ts     # Logging with Bun.color
├── tests/                # Tests using bun test
│   ├── config.test.ts
│   ├── worktree.test.ts
│   └── tmux.test.ts
├── package.json
├── tsconfig.json
├── biome.json            # Biome config
├── .wct.yaml             # Example config
└── README.md
```

---

## MVP Scope

### In Scope (v0.1)

- `wct open <branch>` - full workflow (with `--existing` flag)
- `wct list` - show worktrees with tmux session status
- `wct init` - generate starter config
- Global + project config with merging
- Tmux layout (panes or windows, configurable)
- Configurable IDE command
- Warning-based error handling

### Out of Scope (Future)

- Multiple named presets
- `wct rm` cleanup command
- Interactive mode with React Ink
- Auto-attach to existing tmux session
- Git hooks integration

---

## Example Usage

```bash
# First time setup
cd ~/projects/myapp
wct init                    # Creates .wct.yaml template

# Edit .wct.yaml with your preferences

# Create new worktree for a feature
wct open feature-auth       # Creates worktree, installs deps, starts tmux, opens IDE

# Check out an existing remote branch
wct open feature-auth -e    # Uses existing branch instead of creating new

# List active worktrees
wct list
# Output:
# BRANCH          WORKTREE                         TMUX SESSION              STATUS
# feature-auth    ~/worktrees/myapp/feature-auth   myapp-feature-auth        attached
# fix-login       ~/worktrees/myapp/fix-login      myapp-fix-login           detached
# main            ~/projects/myapp                 -                         -
```

# tab-cli - Product Requirements Document

## Overview

`tab` is a command-line tool that automates the git worktree workflow, enabling developers to quickly spin up isolated development environments for different branches with pre-configured tooling, tmux sessions, and IDE integration.

## Problem Statement

When working on multiple features or bug fixes simultaneously, developers need to:

1. Create git worktrees manually
2. Copy configuration files (.env, CLAUDE.md, etc.) to each worktree
3. Install dependencies in the new directory
4. Set up their terminal environment (tmux sessions, dev servers)
5. Open their IDE in the correct directory

This repetitive process is time-consuming and error-prone. `tab` automates the entire workflow with a single command.

## Target Users

- Developers who work on multiple branches/features concurrently
- Teams using git worktrees for parallel development
- Developers using tmux for terminal session management

---

## Core Features

### Commands

| Command | Description |
|---------|-------------|
| `tab open <branch>` | Create worktree, run setup, start tmux session, open IDE |
| `tab open <branch> -e, --existing` | Same as above but for existing branch (no -b flag) |
| `tab list` | Show active worktrees with tmux session status (attached/detached) |
| `tab init` | Generate a starter `.tabrc.yaml` config file |

### Configuration

**Config File Locations (in order of precedence):**

1. `.tabrc.yaml` (project root) - project-specific config
2. `~/.tabrc.yaml` - global defaults

**Config Schema:**

```yaml
# .tabrc.yaml
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

# IDE command (TAB_WORKTREE_DIR env var available)
ide:
  command: "cursor $TAB_WORKTREE_DIR"
  # or: "code $TAB_WORKTREE_DIR"

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

### Workflow (`tab open`)

When user runs `tab open feature-auth`:

1. **Validate** - Check git repo, config exists, branch name valid
2. **Create worktree** - `git worktree add <path> -b <branch>` or checkout existing
3. **Copy files** - Copy configured files from main repo to worktree
4. **Run setup commands** - Execute setup commands in order (with warnings on failure)
5. **Start tmux session** - Create session named `project-branch` with configured layout
6. **Open IDE** - Execute IDE command with worktree path

### Error Handling

- **Continue with warnings**: If a step fails (e.g., dependency install), log a warning and proceed to next steps
- **Clear error messages**: Show which step failed and why
- **Idempotent operations**: Running `tab open` on existing worktree should handle gracefully

### Environment Variables

Available in config commands:

| Variable | Description |
|----------|-------------|
| `TAB_WORKTREE_DIR` | Full path to the worktree directory |
| `TAB_MAIN_DIR` | Full path to the main repository directory |
| `TAB_BRANCH` | Branch name |
| `TAB_PROJECT` | Project name from config |

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
tab-cli/
├── src/
│   ├── index.ts          # Entry point, CLI setup
│   ├── commands/
│   │   ├── open.ts       # tab open command
│   │   ├── list.ts       # tab list command
│   │   └── init.ts       # tab init command
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
├── .tabrc.yaml           # Example config
└── README.md
```

---

## MVP Scope

### In Scope (v0.1)

- `tab open <branch>` - full workflow (with `--existing` flag)
- `tab list` - show worktrees with tmux session status
- `tab init` - generate starter config
- Global + project config with merging
- Tmux layout (panes or windows, configurable)
- Configurable IDE command
- Warning-based error handling

### Out of Scope (Future)

- Multiple named presets
- `tab rm` cleanup command
- Interactive mode with React Ink
- Auto-attach to existing tmux session
- Git hooks integration

---

## Example Usage

```bash
# First time setup
cd ~/projects/myapp
tab init                    # Creates .tabrc.yaml template

# Edit .tabrc.yaml with your preferences

# Create new worktree for a feature
tab open feature-auth       # Creates worktree, installs deps, starts tmux, opens IDE

# Check out an existing remote branch
tab open feature-auth -e    # Uses existing branch instead of creating new

# List active worktrees
tab list
# Output:
# BRANCH          WORKTREE                         TMUX SESSION              STATUS
# feature-auth    ~/worktrees/myapp/feature-auth   myapp-feature-auth        attached
# fix-login       ~/worktrees/myapp/fix-login      myapp-fix-login           detached
# main            ~/projects/myapp                 -                         -
```

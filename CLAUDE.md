# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`tab-cli` is a CLI tool that automates git worktree workflows. It enables developers to quickly create isolated development environments for different branches with pre-configured tooling, tmux sessions, and IDE integration.

## Commands

```bash
bun install              # Install dependencies
bun run index.ts         # Run the CLI
bun test                 # Run tests
bun test --watch         # Run tests in watch mode
bunx biome check --write # Format and lint code
bunx biome check         # Check without writing
```

## Architecture

The planned file structure follows this layout:

```
src/
├── index.ts              # Entry point, CLI setup with util.parseArgs
├── commands/
│   ├── open.ts           # tab open <branch> - full worktree workflow
│   ├── list.ts           # tab list - show active worktrees
│   └── init.ts           # tab init - generate .tabrc.yaml
├── config/
│   ├── loader.ts         # Load & merge configs (project + global)
│   ├── schema.ts         # Config type definitions
│   └── validator.ts      # Config validation
├── services/
│   ├── worktree.ts       # Git worktree operations
│   ├── copy.ts           # File copying utilities
│   ├── setup.ts          # Run setup commands
│   ├── tmux.ts           # Tmux session management
│   └── ide.ts            # IDE launcher
└── utils/
    └── logger.ts         # Logging with Bun.color
```

## Bun Runtime

Use Bun exclusively - no Node.js fallback. Leverage Bun built-in APIs:

- `Bun.$\`command\`` for shell execution (git, tmux commands)
- `Bun.file()` / `Bun.write()` for file I/O
- `Bun.YAML.parse()` for config parsing
- `Bun.color("red", "ansi")` for terminal colors
- `import { parseArgs } from "util"` for CLI argument parsing

This project has **zero runtime dependencies** by design.

## Config System

Config files (`.tabrc.yaml`) are loaded from:
1. Project root (takes precedence)
2. `~/.tabrc.yaml` (global defaults)

Environment variables available in config commands:
- `TAB_WORKTREE_DIR` - worktree path
- `TAB_MAIN_DIR` - main repo path
- `TAB_BRANCH` - branch name
- `TAB_PROJECT` - project name

## Code Style

- Indentation: tabs
- Quotes: double quotes
- Biome handles linting and formatting
- Use warning-based error handling (log and continue on non-critical failures)

## Testing

```ts
import { test, expect } from "bun:test";

test("example", () => {
  expect(1).toBe(1);
});
```

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`wct` is a CLI tool that automates git worktree workflows. It enables developers to quickly create isolated development environments for different branches with pre-configured tooling, tmux sessions, and IDE integration.

## Commands

```bash
bun install              # Install dependencies
bun run src/index.ts     # Run the CLI
bun test                 # Run tests
bun test --watch         # Run tests in watch mode
bunx biome check --write # Format and lint code
bunx biome check         # Check without writing
```

## Architecture

The file structure follows this layout:

```
src/
├── index.ts              # Entry point, CLI setup with util.parseArgs
├── commands/
│   ├── open.ts           # wct open <branch> - full worktree workflow
│   ├── up.ts             # wct up - start tmux session and open IDE
│   ├── down.ts           # wct down - kill tmux session
│   ├── close.ts          # wct close <branch> - kill session and remove worktree
│   ├── list.ts           # wct list - show active worktrees
│   ├── init.ts           # wct init - generate .wct.yaml
│   ├── completions.ts    # Shell completions (bash, zsh, fish)
│   └── registry.ts       # Command definitions for help and completions
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
    ├── logger.ts         # Logging with Bun.color
    └── prompt.ts         # User confirmation prompts
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

Config files (`.wct.yaml`) are loaded from:
1. Project root (takes precedence)
2. `~/.wct.yaml` (global defaults)

Environment variables available in config commands:
- `WCT_WORKTREE_DIR` - worktree path
- `WCT_MAIN_DIR` - main repo path
- `WCT_BRANCH` - branch name
- `WCT_PROJECT` - project name

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

# CLAUDE.md

This file provides guidance to AI Agents when working with code in this repository.

## Project Overview

`wct` is a CLI tool that automates git worktree workflows. It enables developers to quickly create isolated development environments for different branches with pre-configured tooling, tmux sessions, and IDE integration.

## Commands

```bash
bun install              # Install dependencies
bun run src/index.ts     # Run the CLI
bun test                 # Run tests
bunx biome check --write # Format and lint code
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
│   ├── switch.ts         # wct switch - quick tmux session switching
│   ├── cd.ts             # wct cd - open shell in worktree directory
│   ├── init.ts           # wct init - generate .wct.yaml
│   ├── completions.ts    # Shell completions (bash, zsh, fish)
│   ├── completions-def.ts # Completion definitions co-located with commands
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
│   ├── ide.ts            # IDE launcher
│   ├── github.ts         # GitHub PR integration
│   └── vscode-workspace.ts # VS Code workspace file generation
├── types/
│   └── env.ts            # Environment variable type definitions
└── utils/
    ├── logger.ts         # Logging with Bun.color
    ├── prompt.ts         # User confirmation prompts
    └── result.ts         # Result type utility
```

## Bun Runtime

Use Bun exclusively - no Node.js fallback. Leverage Bun built-in APIs:

- `Bun.$\`command\`` for shell execution (git, tmux commands)
- `Bun.file()` / `Bun.write()` for file I/O
- `Bun.YAML.parse()` for config parsing
- `Bun.color("red", "ansi")` for terminal colors
- `import { parseArgs } from "util"` for CLI argument parsing

The only runtime dependencies are `effect` and `@effect/platform-bun`. No other runtime dependencies should be added.

This project uses **Effect v4**. If your training data covers Effect v3, read [EFFECT_V4.md](./EFFECT_V4.md) for the correct v4 APIs and patterns.

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

- Indentation: spaces
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

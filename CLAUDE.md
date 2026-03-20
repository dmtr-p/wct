# CLAUDE.md

This file provides guidance to AI Agents when working with code in this repository.

## Project Overview

`wct` is a CLI tool that automates git worktree workflows. It enables developers to quickly create isolated development environments for different branches with pre-configured tooling, tmux sessions, and IDE integration.

## Commands

```bash
bun install              # Install dependencies
bun run src/index.ts     # Run the CLI
bun test                 # Run tests (vitest)
bunx biome check --write # Format and lint code
```

## Architecture

The file structure follows this layout:

```
src/
├── index.ts              # Entry point; handles completions/version shortcuts and runs the Effect root via BunRuntime.runMain
├── errors.ts             # Unified error types (WctCommandError) and error constructors
├── cli/
│   ├── root-command.ts   # Effect CLI root command tree and command dispatch
│   └── completions.ts    # Custom shell completions layered on top of the Effect CLI UX
├── commands/
│   ├── command-def.ts    # Shared command option and metadata interfaces
│   ├── open.ts           # Native Effect implementation of wct open <branch>
│   ├── up.ts             # Native Effect implementation of wct up
│   ├── down.ts           # Native Effect implementation of wct down
│   ├── close.ts          # Native Effect implementation of wct close <branch>
│   ├── list.ts           # Native Effect implementation of wct list
│   ├── switch.ts         # Native Effect implementation of wct switch
│   ├── cd.ts             # Native Effect implementation of wct cd
│   ├── init.ts           # Native Effect implementation of wct init
│   ├── notify.ts         # Native Effect implementation of wct notify
│   ├── queue.ts          # Native Effect implementation of wct queue
│   └── hooks.ts          # Native Effect implementation of wct hooks
├── config/
│   ├── loader.ts         # Effect-based config loading and merge flow
│   ├── schema.ts         # Effect Schema model for .wct.yaml
│   └── validator.ts      # Validation helpers and path-aware error rendering
├── effect/
│   ├── cli.ts            # Re-exports for Effect unstable CLI modules
│   ├── runtime.ts        # Bun runtime helpers and BunServices provisioning
│   └── services.ts       # Live service bundle provided to the app
├── services/
│   ├── worktree-service.ts # Effect service for git worktree operations
│   ├── copy.ts           # File copying utilities
│   ├── filesystem.ts     # Effect-based filesystem helpers (pathExists, ensureDirectory, stat)
│   ├── process.ts        # Effect-based process spawning (execProcess, runProcess)
│   ├── setup-service.ts  # Effect service for setup command execution
│   ├── tmux.ts           # Tmux session management
│   ├── ide-service.ts    # Effect service for IDE launching
│   ├── github-service.ts # Effect service for GitHub PR integration
│   ├── hooks-service.ts  # Effect service for git hook installation
│   ├── queue-storage.ts  # SQLite-backed queue persistence service
│   └── vscode-workspace.ts # Effect service and helpers for VS Code workspace forking
├── types/
│   └── env.ts            # Environment variable type definitions
└── utils/
    ├── bin.ts            # wct binary resolution and shell command formatting
    ├── logger.ts         # Effect-native logging helpers
    └── prompt.ts         # Effect-native prompt helpers
```

## Bun Runtime

Use Bun exclusively - no Node.js fallback. The runtime boundary is:

- `effect` for the application, services, errors, schemas, and CLI
- `effect/unstable/cli` for the root command tree and built-in CLI UX
- `@effect/platform-bun` for `BunRuntime.runMain` and `BunServices.layer`

Leverage Bun built-in APIs where they are still the right primitive:

- `Bun.YAML.parse()` for config parsing
- `Bun.spawn(...)` for interactive inherited-stdio process handoff
- `Bun.Glob` for copy pattern expansion
- `Bun.which` for executable lookup

The only runtime dependencies are `effect` and `@effect/platform-bun`. No other runtime dependencies should be added. The only dev dependency exceptions are `@biomejs/biome`, `@types/bun`, and `vitest`.

This project uses **Effect v4**. If your training data covers Effect v3, read [EFFECT_V4.md](./EFFECT_V4.md) for the correct v4 APIs and patterns. `src/index.ts` should stay thin: it wires completions/version shortcuts, builds the root Effect program, provides live services, and hands execution to `BunRuntime.runMain`.

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

Tests use [vitest](https://vitest.dev/) as the test runner. Run tests with `bun test` (which invokes `vitest run`).

```ts
import { test, expect } from "vitest";

test("example", () => {
  expect(1).toBe(1);
});
```

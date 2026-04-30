## Commands

```bash
bun run src/index.ts     # Run the CLI
bun run test             # Run tests (vitest)
```

**Do not run tests or linting manually.** Claude Code hooks handle this automatically:
- **PostToolUse**: `biome format --write` runs on every file edit
- **Stop**: `biome lint --write` and `bun run test` run when the session stops, waking the agent on failure (exit code 2)

## Architecture

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
│   ├── projects.ts       # Native Effect implementation of wct projects add/remove/list
│   ├── session.ts        # Native Effect implementation of wct session
│   └── tui.ts            # Native Effect implementation of wct tui
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
│   ├── vscode-workspace.ts # Effect service and helpers for VS Code workspace forking
│   ├── registry-service.ts # Effect service for multi-repo registry
│   └── worktree-status.ts  # Helpers for computing worktree status
├── tui/
│   ├── App.tsx            # Root Ink component, data fetching, keyboard routing
│   ├── runtime.ts         # ManagedRuntime for TUI-specific Effect services
│   ├── types.ts           # TUI mode, detail kind, and PR info type definitions
│   ├── components/
│   │   ├── TreeView.tsx   # Collapsible repo/worktree list
│   │   ├── RepoNode.tsx   # Single repo group
│   │   ├── WorktreeItem.tsx # Branch line with status indicators
│   │   ├── OpenModal.tsx  # Modal for wct open
│   │   ├── StatusBar.tsx  # Bottom keybinding hints
│   │   ├── Modal.tsx      # Generic modal wrapper
│   │   ├── DetailRow.tsx  # Single row in detail/status views
│   │   └── ScrollableList.tsx # Scrollable list with cursor blinking
│   └── hooks/
│       ├── useRegistry.ts # Fetch repos from DB, discover worktrees via git
│       ├── useRefresh.ts  # Hybrid poll + fs.watch
│       ├── useTmux.ts     # switch-client, list-clients
│       ├── useBlink.ts    # Toggling boolean for cursor blink animation
│       └── useGitHub.ts   # Fetch PR and check status from GitHub
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

The only runtime dependencies are `effect` and `@effect/platform-bun`. No other runtime dependencies should be added. Exception: `ink` and `react` are runtime dependencies used exclusively by the `wct tui` subcommand. They are lazy-imported so they are never loaded for other commands. The only dev dependency exceptions are `@biomejs/biome`, `@types/bun`, `vitest`, and `@effect/vitest`.

This project uses **Effect v4**. If your training data covers Effect v3, read [EFFECT_V4.md](./EFFECT_V4.md) for the correct v4 APIs and patterns. `src/index.ts` should stay thin: it wires completions/version shortcuts, builds the root Effect program, provides live services, and hands execution to `BunRuntime.runMain`.

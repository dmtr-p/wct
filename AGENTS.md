## Commands

```bash
bun run src/index.ts     # Run the CLI
bun run test             # Run tests (vitest)
```

**Do not run tests or linting manually.** The Stop hook configured in
`.codex/hooks.json` runs `.codex/hooks/stop.sh` when the session stops. It runs
`bunx biome check --write --error-on-warnings .`, `bun run typecheck`, and
`bun run test -- --reporter=agent`, and blocks completion with the failing
check's output if any step fails.

## Architecture

```
src/
├── index.ts              # Entry point; handles completions/version shortcuts and runs the Effect root via BunRuntime.runMain
├── errors.ts             # Unified error types (WctCommandError) and error constructors
├── cli/
│   ├── root-command.ts   # Effect CLI root command tree and command dispatch
│   ├── completions.ts    # Custom shell completions layered on top of the Effect CLI UX
│   └── json-flag.ts      # Global --json flag
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
│   ├── session.ts        # Shared tmux attach/switch helper used after open and up
│   └── tui.ts            # Native Effect implementation of wct tui
├── config/
│   ├── loader.ts         # Effect-based config loading and merge flow
│   ├── schema.ts         # Effect Schema model for .wct.yaml
│   └── validator.ts      # Validation helpers and path-aware error rendering
├── effect/
│   ├── runtime.ts        # Bun runtime helpers and BunServices provisioning
│   └── services.ts       # Live service bundle provided to the app
├── services/
│   ├── worktree-service.ts # Effect service for git worktree operations and status helpers
│   ├── workspace-service.ts # Open/up/down/close workspace operations shared by CLI and TUI
│   ├── db.ts             # ~/.wct SQLite database paths, schema migrations, and withDb
│   ├── pr-cache-service.ts # Cached GitHub PR payloads with fetch timestamps
│   ├── pr-model.ts       # PR identities, facts, normalization, and status derivation
│   ├── pr-discovery.ts   # Push destination resolution and Workspace PR Association
│   ├── pr-details.ts     # Batched PR checks and review detail fetching
│   ├── pr-merge-service.ts # Merge eligibility, confirmation snapshots, and submission
│   ├── project-registration.ts # Registering a repo in the multi-repo registry
│   ├── copy.ts           # File copying utilities
│   ├── process.ts        # Effect-based process spawning (execProcess, runProcess)
│   ├── setup-service.ts  # Effect service for setup command execution
│   ├── tmux.ts           # Tmux session management
│   ├── github-service.ts # Effect service for GitHub PR integration
│   └── registry-service.ts # Effect service for multi-repo registry
├── tui/
│   ├── App.tsx            # Root Ink component wiring data hooks, modes, modals, and input routing
│   ├── runtime.ts         # ManagedRuntime for TUI-specific Effect services
│   ├── types.ts           # TUI mode, detail kind, and PR info type definitions
│   ├── tree-helpers.ts    # Tree items and rows, expansion, confirmation rows, and scroll helpers
│   ├── tree-navigation.ts # Tree navigation state machine (selection, viewport, return slots)
│   ├── lifecycle.ts       # Per-workspace lifecycle progress, keyed by Workspace Identity
│   ├── pr-layout.ts       # Terminal-width-aware PR title wrapping
│   ├── pr-status.ts       # Compact PR status presentation
│   ├── session-utils.ts   # Safe tmux client handoff decisions and start action messages
│   ├── input/             # Mode-specific keyboard and guarded mouse routing
│   ├── components/
│   │   ├── TreeView.tsx   # Repo list with expandable worktree details
│   │   ├── tree-row.ts    # Shared selected-row styling and width-aware fill
│   │   ├── RepoNode.tsx   # Single repo group
│   │   ├── WorktreeItem.tsx # Branch line with status indicators
│   │   ├── OpenModal.tsx  # Modal for wct open
│   │   ├── UpModal.tsx    # Modal for starting a workspace
│   │   ├── AddProjectModal.tsx # Modal for explicit project registration
│   │   ├── ConfirmModal.tsx # Destructive action confirmations
│   │   ├── PrActionsModal.tsx # PR association and merge action menus
│   │   ├── ShortcutsModal.tsx # Keyboard shortcut reference
│   │   ├── StatusBar.tsx  # Search footer, repository errors, and footer row accounting
│   │   ├── Modal.tsx      # Generic modal wrapper
│   │   ├── ModalShortcut.tsx # Clickable modal shortcut legend
│   │   ├── MouseClickable.tsx # Component bounds, hover, and click handling
│   │   ├── TitledBox.tsx  # Shared titled border
│   │   ├── EditableText.tsx # Text field cursor rendering
│   │   ├── PathInput.tsx  # Directory input with completion
│   │   ├── SessionOptionsSection.tsx # Profile and session option controls
│   │   ├── session-options.ts # Session option values and profile choices
│   │   ├── form-controls.tsx # Shared toggle and submit controls
│   │   ├── DetailRow.tsx  # Single row in detail/status views
│   │   ├── LifecycleProgressRow.tsx # Active Workspace lifecycle phase
│   │   ├── RepoEmptyRow.tsx # Empty-repo visual row
│   │   ├── WorktreeStatsRow.tsx # Worktree status visual row
│   │   └── ScrollableList.tsx # Filterable scrollable list with scrollbar
│   ├── hooks/
│   │   ├── useTreeNavigation.ts # React binding for the tree navigation state machine
│   │   ├── useMouse.ts    # Terminal mouse reporting lifecycle
│   │   ├── useGuardedInput.ts # Keyboard/mouse input routing
│   │   ├── useSessionActions.ts # Tmux handoff and start/down/close worktree actions
│   │   ├── useModalActions.ts # Open/up/add modal orchestration
│   │   ├── useProjectActions.ts # Project deletion and safe session handoff
│   │   ├── useSessionOptionsState.ts # Shared session option state
│   │   ├── useActionError.ts # Timed action error state
│   │   ├── useRegistry.ts # Fetch repos from DB, discover worktrees via git
│   │   ├── useRefresh.ts  # Hybrid poll + fs.watch
│   │   ├── useTmux.ts     # Tmux sessions, panes, and clients (switch, detach, zoom)
│   │   ├── useBlink.ts    # Toggling boolean for blink animations (used by useCursorBlink)
│   │   ├── useCursorBlink.ts # Editing cursor visibility and blink resets
│   │   ├── useTextEditing.ts # Cursor movement, insertion, and deletion for text fields
│   │   └── useGitHub.ts   # Workspace PR Associations, open PR lists, and refreshes
│   └── utils/
│       ├── display-width.ts # Grapheme and terminal column measurements
│       ├── truncate.ts    # Width-aware text truncation
│       └── wrap-text.ts   # Width-aware text wrapping
├── types/
│   └── env.ts            # Environment variable type definitions
└── utils/
    ├── bin.ts            # wct binary resolution and shell command formatting
    ├── json-output.ts    # JSON success/error envelopes for --json mode
    ├── logger.ts         # Effect-native logging helpers
    └── prompt.ts         # Effect-native prompt helpers
```

## Bun Runtime

Use Bun exclusively - no Node.js fallback. The runtime boundary is:

- `effect` for the application, services, errors, schemas, and CLI
- `effect/cli` for the root command tree and built-in CLI UX
- `@effect/platform-bun` for `BunRuntime.runMain` and `BunServices.layer`

Leverage Bun built-in APIs where they are still the right primitive:

- `Bun.YAML.parse()` for config parsing
- `Bun.spawn(...)` for interactive inherited-stdio process handoff
- `Bun.Glob` for copy pattern expansion
- `Bun.which` for executable lookup

The only runtime dependencies are `effect` and `@effect/platform-bun`. No other runtime dependencies should be added. Exception: `ink` and `react` are runtime dependencies used exclusively by the `wct tui` subcommand. They are lazy-imported so they are never loaded for other commands. The only dev dependencies are `@biomejs/biome`, `@types/bun`, `@types/react`, `react-devtools-core`, `typescript`, `vitest`, and `@effect/vitest`.

This project uses **Effect v4**. Read [EFFECT_V4.md](./EFFECT_V4.md) for the current APIs and repository patterns. `src/index.ts` should stay thin: it wires completions/version shortcuts, builds the root Effect program, provides live services, and hands execution to `BunRuntime.runMain`.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical role names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

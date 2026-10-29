## Commands

```bash
bun run src/index.ts     # Run the CLI
bun run test             # Run tests (vitest)
```

**Do not run tests or linting manually.** Codex and Claude stop hooks run
`mise run lint:fix`, `mise run format`, and `mise run test`. Each task caches
successful runs separately using source content hashes. If a check fails or
the tools modify files, the hooks block completion so the agent can fix or
review the changes. Git pre-commit runs `mise run pre-commit` to check lint,
formatting, and tests without applying fixes.

## Documentation and comments

Describe current behavior and repository conventions. Keep release histories,
migration narratives, and dated work logs out of documentation. Comments should
explain constraints or non-obvious reasoning; omit descriptions that repeat the
code.

Keep each document focused on its named topic. Put current subsystem behavior
in a dedicated `docs/<topic>.md`; use `docs/adr/` for architectural decisions
and their rationale. Link across topics instead of appending unrelated details
or duplicating them. Check the document's scope before adding a section.
See [documentation placement](docs/agents/domain.md) for ownership and discovery.

## Architecture

```
src/
├── index.ts              # CLI, completion helpers, version shortcuts, and shutdown worker dispatch
├── errors.ts             # Unified error types (WctCommandError) and error constructors
├── cli/
│   ├── command-metadata.ts # Shared native CLI parameters and derived completion metadata
│   ├── completion-profiles.ts # Resolved profile names for shell completions
│   ├── global-options.ts # Global option metadata and supported completion shells
│   ├── root-command.ts   # Effect CLI root command tree and command dispatch
│   ├── completions.ts    # Custom shell completions layered on top of the Effect CLI UX
│   ├── completions-flag.ts # Supported --completions shell choices
│   └── json-flag.ts      # Global --json flag
├── commands/
│   ├── command-def.ts    # Shared command option and metadata interfaces
│   ├── open.ts           # Native Effect implementation of wct open <branch>
│   ├── up.ts             # Native Effect implementation of wct up
│   ├── down.ts           # Native Effect implementation of wct down
│   ├── down-reporter.ts  # Human output for shutdown progress and failures
│   ├── close.ts          # Native Effect implementation of wct close <branch...>
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
│   ├── service-context.ts # Capture service dependencies while preserving caller settings
│   ├── services.ts       # Live service bundle provided to the app
│   └── shutdown-worker.ts # Independent shutdown execution and outcome persistence
├── services/
│   ├── agent-service.ts  # Foreground agent observation and freshness tracking
│   ├── agent-process.ts  # Bounded foreground process inspection
│   ├── agent-model.ts    # Agent identities, screen regions, states, and summaries
│   ├── agent-rules.ts    # Claude Code and Codex detection rules
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
│   ├── ignored-files.ts  # Gitignored regular-file discovery and eligibility checks
│   ├── include-copy-state.ts # Persistent retry state for initial include copying
│   ├── worktree-include.ts # Root .worktreeinclude matching with Git ignore syntax
│   ├── command-runner.ts # Sequential shell command execution shared by setup and down
│   ├── process.ts        # Effect-based process spawning (execProcess, runProcess)
│   ├── setup-service.ts  # Effect service for setup command execution
│   ├── shutdown-runner.ts # Detached shutdown handoff and safe result staging
│   ├── tmux.ts           # Tmux session management
│   ├── github-service.ts # Effect service for PR resolution, raw fetching, and fork remotes
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
│   ├── pr-actions.ts      # Typed PR menu state, requests, transitions, and options
│   ├── session-utils.ts   # Safe tmux client handoff decisions and start action messages
│   ├── session-handoff.ts # Open/up client switching after lifecycle presentation cleanup
│   ├── workspace-warning.ts # Shared lifecycle warning messages
│   ├── input/             # Mode-specific keyboard, terminal parsing, and guarded mouse routing
│   │   ├── common-navigation.ts # Shared navigation shortcuts across tree modes
│   │   ├── confirm-kill.ts # Kill confirmation input
│   │   ├── expanded.ts    # Expanded branch detail input
│   │   ├── mouse.ts       # Mouse sequence parsing and tree hit-testing
│   │   ├── navigate.ts    # Tree navigation and action input
│   │   └── terminal-input.ts # Buffered terminal input shared with Ink
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
│   │   ├── useAgents.ts   # Agent observation loop and TUI state
│   │   ├── useTreeNavigation.ts # React binding for the tree navigation state machine
│   │   ├── useMouse.ts    # Terminal mouse reporting lifecycle
│   │   ├── useGuardedInput.ts # Keyboard/mouse input routing
│   │   ├── useFieldFocus.ts # Shared modal field identity, cycling, and focus selection
│   │   ├── useSessionActions.ts # Tmux handoff and start/down/close worktree actions
│   │   ├── useModalActions.ts # Open/up/add modal orchestration
│   │   ├── useProjectActions.ts # Project removal and safe session handoff
│   │   ├── usePrActions.ts # React binding and service wiring for PR actions
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

The runtime dependencies are `effect`, `@effect/platform-bun`, `ink`, and `react`. No other runtime dependencies should be added. `ink` and `react` are used exclusively by the `wct tui` subcommand and are lazy-imported so they are never loaded for other commands. The only dev dependencies are `oxlint`, `oxlint-tsgolint`, `@types/bun`, `@types/react`, `react-devtools-core`, `typescript`, `vitest`, `@effect/vitest`, and `@effect/tsgo`.

This project uses **Effect v4**. Read [EFFECT_V4.md](./EFFECT_V4.md) for the current APIs and repository patterns. `src/index.ts` should stay thin: it handles completions/version shortcuts, dispatches the CLI, private profile completion helper, or shutdown worker, provides live services, and hands execution to `BunRuntime.runMain`.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical role names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Shared vocabulary lives in `CONTEXT.md`, subsystem behavior in `docs/<topic>.md`,
and architectural decisions in `docs/adr/`. See `docs/agents/domain.md`.

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

- `src/index.ts` handles CLI dispatch, completion/version shortcuts, and the
  shutdown worker entry point.
- `src/cli/` owns native Effect CLI parameters, command metadata, shell
  completions, global flags, and terminal output.
- `src/commands/` adapts CLI input and output to services.
- `src/config/` owns configuration schemas, validation, loading, and profiles.
- `src/effect/` constructs service layers, captures dependencies, and provides
  Bun runtime and shutdown worker boundaries.
- `src/services/` owns Git worktrees, Workspace Operations, tmux, setup/down
  commands, copying, the project registry, GitHub PRs, and agent observation.
  `workspace-service.ts` shares lifecycle behavior between CLI and TUI callers.
- `src/tui/App.tsx` wires data hooks, navigation, modes, and modals.
  `hooks/` owns React state and refreshes, `input/` routes terminal events,
  and `components/` renders the shared tree row model.
  `tree-navigation.ts`, `lifecycle.ts`, and `pr-actions.ts` own navigation,
  Workspace lifecycle, and PR action state respectively.
- `src/tui/utils/` owns terminal text measurement, truncation, and wrapping.
- `src/utils/` owns CLI logging, JSON envelopes, and prompts.
  `src/errors.ts` defines command errors; `src/types/env.ts` defines the
  Workspace environment.

Subsystem behavior and architectural decisions are indexed in
[domain docs](docs/agents/domain.md).

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

# Effect v4 conventions

This document covers repository choices that are not enforced by types or
linting. Tooling and diagnostics live in [development tooling](docs/development.md),
test patterns in [testing](docs/testing.md), and runtime constraints in
[AGENTS.md](AGENTS.md#bun-runtime).

## Dependencies and imports

Keep `effect`, `@effect/platform-bun`, and `@effect/vitest` on matching exact
versions in `package.json`, without `^` or `~`. Resolved transitive Effect runtime
packages in `bun.lock`, including `@effect/platform-node-shared`, must match too.
Update these packages together. `@effect/tsgo` versions independently.

Application code imports Bun runtime services through `src/effect/runtime.ts`;
standalone scripts can import platform adapters directly. Use the exported
`JsonFlag` from `src/cli/json-flag.ts`; `GlobalFlag.Setting` generates runtime
service keys with unique suffixes, so reconstructing its key loses the setting.

## CLI integration

Use `Command.validate` for input-only constraints before handlers run. Keep
service validation for callers such as the TUI. Optional empty strings retain
the service's truthiness semantics; report conflicting PR options before
`--existing`/`--base`.

Application boolean switches use `Flag.withoutNegation` so custom completions
and accepted spellings agree. `CompletionsFlag` restricts shells to Bash, Zsh,
and Fish; custom generators add branch, worktree, and profile suggestions.
Profile completion identifiers remain data without evaluating shell text.

Built-in actions are configured through `CliConfig.layer` in `src/index.ts`.
`src/cli/output.ts` uses `CliOutput.layerPresenter` to suppress implicit help
and invalid-invocation output in JSON mode. Explicit help and version remain
visible. Review CLI behavior and help output when upgrading its unstable APIs.

Confirmations go through `src/utils/prompt.ts`. JSON mode returns `false`
without acquiring terminal input; `close --json --yes` authorizes closing.

`src/utils/logger.ts` builds `TerminalCapabilities.layer` per execution because
the default capability and config references cache their first environment
snapshot. It preserves an explicit Config provider and detects stdout and stderr
independently. `TERM=dumb` disables color; nonempty `NO_COLOR` wins over
`FORCE_COLOR`. Nonempty `FORCE_COLOR` forces styling except for `0` and
case-insensitive `false`, which retain TTY detection. JSON mode disables styling.
For table cells and hints, use `logger.stdoutStyles` inside the Effect.

The CLI output boundary writes formatted strings directly to the streams because
Bun's console can add styling. A closed stdout pipe exits successfully; a closed
stderr pipe exits with failure, without an EPIPE stack trace.

## Services and runtime boundaries

Service identifiers are runtime identities; use distinct `wct/<ServiceName>`
keys. Keep the `live<ServiceName>Service` naming convention for concrete
implementations and `make<ServiceName>Service` for their factories.

Service factories capture dependencies during layer construction. Capture only
service dependencies so caller settings such as `JsonFlag` and `Console` remain
effective.
`makeWctServicesLayer` applies overrides before constructing the Workspace
service. Platform services must be present during construction.

CLI, TUI, and test bundles share platform dependencies within each construction.
Use `Layer.fresh` only for independent bundle instances.

Imperative callbacks that execute Effects use `Effect.runPromiseWith` or
`Effect.runSyncWith` to preserve caller services and settings. The TUI owns a
process-scoped `ManagedRuntime` in `src/tui/runtime.ts`.

Use `src/services/process.ts` for scoped stdout, stderr, and exit-code collection,
and `execShell` for shell scripts. Interactive handoff uses inherited-stdio
`Bun.spawn`. Self-session shutdown uses a detached worker; see
[Workspace shutdown](docs/workspace-operations.md#shutdown).

Read runtime settings with `loadRuntimeConfig` from `src/effect/config.ts`.
It preserves explicit providers and otherwise reads a fresh environment snapshot,
including empty strings. Subprocess inheritance uses `processEnvironment` from
`src/services/process.ts` independently of Config overrides.

Use `FileSystem.lstat` when selecting regular files without following symlinks.

## Errors

Use `WctCommandError` and the constructors in `src/errors.ts` for command errors.
Workspace reporter failures and defects are discarded with `Effect.ignoreCause`
so reporting cannot fail an operation.

`Effect.partition` returns `[successes, failures]`.

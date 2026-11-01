# Development tooling

Use the Bun version pinned in [mise.toml](../mise.toml) for development and
builds. See the [README quick start](../README.md#development) for installation
and CLI commands, and [testing](testing.md) for test helpers and isolation.

## Dependency preparation

Lifecycle scripts are disabled in [bunfig.toml](../bunfig.toml). Run
`bun run prepare` explicitly after `bun install` to patch the pinned TypeScript
compiler, Oxlint, and oxlint-tsgolint with `@effect/tsgo`. Worktree setup and CI
include this step.

Before changing TypeScript, Oxlint, oxlint-tsgolint, or `@effect/tsgo`, check the
installed `@effect/tsgo` package's `README.md` for compatible versions.
The [Effect reference](../EFFECT_V4.md#packages-and-imports) defines version
pinning for the runtime and test packages.

## Checks and diagnostics

The scripts in [package.json](../package.json) define the underlying checks:

| Command                | Behavior                                                |
| ---------------------- | ------------------------------------------------------- |
| `bun run lint`         | Check lint, TypeScript types, and Effect diagnostics    |
| `bun run lint:fix`     | Run the same checks and apply safe lint fixes           |
| `bun run format`       | Format files and sort imports with Bun                  |
| `bun run format:check` | Check formatting and import order without writing files |
| `bun run test`         | Run the full Vitest suite                               |

CI checks lint, types, formatting, and tests. CI and hooks use Oxlint's
`options.typeCheck` instead of running the TypeScript compiler separately.
Errors and warnings fail the lint check; suggestion-level refactors stay outside
the lint gate and remain available in the editor.

[.oxlintrc.json](../.oxlintrc.json) uses the strict Effect preset and repository
overrides. [tsconfig.json](../tsconfig.json) configures compiler and editor
diagnostics independently of Oxlint's severities. The React Compiler rules for
refs, state updates in effects, globals, and immutability are disabled because
the Ink TUI uses explicit mutable refs and Effect polling without React Compiler.
Bun's `[fmt]` and `[fmt.sortImports]` settings in `bunfig.toml` own formatting
and import sorting.

## Task caching

Mise tasks cache successful lint, format, and test runs separately using source
content hashes and automatic output markers. Source additions, deletions, and
content changes invalidate the relevant task; configuration and dependency
inputs are included. A documentation edit reruns formatting while lint and tests
can stay cached. Use `mise run --force <task>` to bypass a task's cache. The
underlying `bun run` scripts always run their tools directly.

## Hooks

`mise run hooks:install` configures Git to use the versioned `.githooks` directory.
The [pre-commit hook](../.githooks/pre-commit) clears Git's repository-specific
environment variables so checks can create independent temporary repositories
and worktrees. It runs `mise run pre-commit`, which checks lint, formatting, and
the full test suite against the working tree without applying fixes or staging
files. Check tasks have separate caches from their fixing counterparts; tests
share one cache across pre-commit and agent hooks. Mise and the pinned Bun
version must be installed and available to the hooks.

Codex and Claude use the same [stop script](../.codex/hooks/stop.sh) to run
`mise run lint:fix`, `mise run format`, and `mise run test` in order. Failures
block completion with the tool output. If lint or formatting changes files,
completion is blocked for review before tests run. The test task runs the full
suite with Vitest's compact agent reporter. Agents follow
[AGENTS.md](../AGENTS.md#commands) for hook-managed checks.

## Editor setup

For VS Code-based editors, install the TypeScript 7 extension and select the
workspace TypeScript version when prompted. The
[workspace settings](../.vscode/settings.json) point to the patched compiler for
Effect diagnostics, quick fixes, and refactors.

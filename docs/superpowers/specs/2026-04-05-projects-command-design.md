# Projects Command Design

Replace top-level `register` / `unregister` commands with a single `projects` parent command and three subcommands: `add`, `remove`, `list`. No backwards compatibility — the old commands are deleted.

## Commands

### `wct projects`

Parent command. No default action — shows subcommand help.

### `wct projects add [path] [--name NAME]`

Register a repo in the project registry.

- `path` — optional positional, defaults to cwd
- `--name` — optional flag, overrides auto-detected project name
- Resolves path, validates it's a git repo
- Auto-detects project name from `.wct.yaml` config, falls back to directory basename
- `--name` flag takes priority over both
- Calls `RegistryService.register(repoPath, projectName)`
- Logs success; with `--json`, outputs the `RegistryItem` object

### `wct projects remove [path]`

Remove a repo from the project registry.

- `path` — optional positional, defaults to cwd
- Resolves path, calls `RegistryService.unregister()`
- Fails with error if repo not found in registry
- Logs success; with `--json`, outputs `{ repo_path, removed: true }`

### `wct projects list`

List all registered projects.

- Calls `RegistryService.listRepos()`
- Prints two-column table: PROJECT and PATH
- Shows "No projects registered" if empty
- With `--json`, outputs array of `RegistryItem` objects

## File Changes

| Action | File | Notes |
|--------|------|-------|
| Create | `src/commands/projects.ts` | Three exported command functions + commandDef |
| Delete | `src/commands/register.ts` | Replaced by `projects add` |
| Delete | `src/commands/unregister.ts` | Replaced by `projects remove` |
| Update | `src/cli/root-command.ts` | Replace register/unregister with `projects` parent + 3 subcommands |
| Update | `src/cli/completions.ts` | Replace register/unregister commandDefs with projects subcommand defs |

## Service Layer

No changes to `RegistryService`. The existing API (`register`, `unregister`, `listRepos`) covers all three subcommands.

## JSON Output

All subcommands respect the `--json` global flag via `JsonFlag`:

- **add**: `{ id, repo_path, project, created_at }`
- **remove**: `{ repo_path, removed: true }`
- **list**: `[{ id, repo_path, project, created_at }, ...]`

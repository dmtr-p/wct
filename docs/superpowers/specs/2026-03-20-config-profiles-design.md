# Config Profiles

Allow users to define named profiles in `.wct.yaml` that override base config sections (`setup`, `ide`, `tmux`, `copy`) per worktree. Profiles are selected explicitly via `--profile` flag or auto-matched by branch name using glob patterns.

## Config Schema

A new top-level `profiles` key is added to the config. Each profile is a named map entry:

```yaml
version: 1
worktree_dir: "../worktrees"
project_name: "wct"

# Base config (applies when no profile matches)
setup:
  - name: "Install dependencies"
    command: "bun install"
ide:
  command: "code $WCT_WORKTREE_DIR"
tmux:
  windows:
    - name: "main"

# Profiles override base sections
profiles:
  frontend:
    match: "feature/frontend-*"
    ide:
      command: "cursor $WCT_WORKTREE_DIR"
    tmux:
      windows:
        - name: "dev"
          command: "bun run dev"
        - name: "test"
          command: "bun test --watch"
  docs:
    match: ["docs/*", "content/*"]
    setup:
      - name: "Install dependencies"
        command: "bun install"
      - name: "Build content index"
        command: "bun run build:index"
    tmux:
      windows:
        - name: "edit"
  minimal:
    # No match glob — only selectable via --profile minimal
    tmux:
      windows:
        - name: "shell"
```

### Profile fields

- `match` — optional. A glob string or array of globs matched against the branch name. Profiles without `match` are only selectable via `--profile`.
- `setup` — optional. Array of setup commands (same schema as top-level `setup`). Replaces base `setup` entirely.
- `ide` — optional. IDE config (same schema as top-level `ide`). Replaces base `ide` entirely.
- `tmux` — optional. Tmux config (same schema as top-level `tmux`). Replaces base `tmux` entirely.
- `copy` — optional. Array of copy patterns (same schema as top-level `copy`). Replaces base `copy` entirely.

## Resolution Rules

1. Base config is loaded and merged (global + project) as it works today.
2. If `--profile <name>` is passed, use that profile. Error if the name is not found in `profiles`.
3. Otherwise, iterate profiles in definition order. The first profile whose `match` glob(s) match the branch name wins.
4. If no profile matches (and no `--profile` flag), base config is used as-is.
5. For the selected profile, each section it defines (`setup`, `ide`, `tmux`, `copy`) **replaces** the corresponding base section entirely. Sections the profile doesn't define fall through from the base.

## CLI Changes

### `wct open`

New option: `--profile` / `-P <name>`

```
wct open my-branch --profile frontend
wct open my-branch -P minimal
```

- `--profile <name>` — explicit selection, errors if the profile doesn't exist
- Without `--profile` — auto-match by branch name, silent fallback to base
- When a profile is selected (either way), log: `Using profile 'frontend'`

### `wct up`

Also accepts `--profile` / `-P`. Determines the branch from the existing worktree for auto-matching.

### No changes needed

`down`, `close`, `list`, `switch`, `cd`, `init`, `notify`, `queue`, `hooks` — these don't use setup/ide/tmux config.

## Implementation

### Schema (`src/config/schema.ts`)

- New `ProfileSchema` struct with:
  - `match`: `Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String)))`
  - `setup`: optional, reuses existing `Schema.Array(SetupCommandSchema)`
  - `ide`: optional, reuses `IdeConfigSchema`
  - `tmux`: optional, reuses `TmuxConfigSchema`
  - `copy`: optional, reuses `Schema.Array(Schema.String)`
- `WctConfigSchema` gains: `profiles: Schema.optional(Schema.Record({ key: Schema.String, value: ProfileSchema }))`
- `ResolvedConfigSchema` gains the same `profiles` field

### Profile resolution (`src/config/loader.ts`)

New function:

```
resolveProfile(config: ResolvedConfig, branch: string, explicitProfile?: string): ResolvedConfig
```

- If `explicitProfile` is set, look up by name, error if missing
- Otherwise, iterate profile entries in key order, use `Bun.Glob` to test branch against each profile's `match` pattern(s)
- First match wins
- Apply profile overrides: for each of `setup`, `ide`, `tmux`, `copy`, if the profile defines it, replace the base value
- Return the effective config

### Command changes (`src/commands/open.ts`, `src/commands/up.ts`)

- Add `--profile` / `-P` option to command definition
- After loading config, call `resolveProfile(config, branch, profileOption)`
- Log selected profile name

### Validation (`src/config/validator.ts`)

- Validate profile sections using the same rules as base sections
- Error if `--profile` references a name not in `profiles`
- Warn if multiple profiles match (first match is used, log which was chosen)

## Glob Matching

Uses `Bun.Glob` — the same primitive already used for copy file matching. The glob is tested against the full branch name string (e.g., `feature/frontend-auth` tested against `feature/frontend-*`).

## Testing

- `resolveProfile` unit tests:
  - Explicit profile selection
  - Glob auto-matching (single glob, array of globs)
  - First-match precedence when multiple profiles match
  - Fallback to base when no profile matches
  - Section replacement (profile `tmux` replaces base `tmux`, base `ide` falls through)
  - Error on unknown `--profile` name
- Config validation tests for invalid profile schemas

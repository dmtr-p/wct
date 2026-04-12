# Up/Down Enhancements Design

Implements [#53](https://github.com/dmtr-p/wct/issues/53) (path/branch flags for CLI) and [#54](https://github.com/dmtr-p/wct/issues/54) (u/d keybindings in TUI).

## CLI: `--path` and `--branch` flags (Issue #53)

### Worktree path resolution

Extract a shared helper `resolveWorktreePath(options: { path?: string; branch?: string })` that:

1. If both `--path` and `--branch` are provided: error (mutually exclusive)
2. If `--path` is provided: return the given path directly
3. If `--branch` is provided: call `WorktreeService.listWorktrees()` from the current repo, find the worktree whose branch matches, return its path. Error if no match found.
4. If neither is provided: return `process.cwd()` (current behavior)

The helper requires being inside a git repo for `--branch` resolution. For `--path`, no repo context is needed since the path is absolute.

### `up` command changes

- Add `--path <path>` and `--branch <name>` flags to `commandDef` and `UpOptions`
- Add corresponding flags to `upCliCommand` in `root-command.ts`
- Use `resolveWorktreePath()` to determine the working directory instead of `process.cwd()`
- Pass resolved path through to config loading, session name derivation, and `launchSessionAndIde`

### `down` command changes

- Add `--path <path>` and `--branch <name>` flags to `commandDef` and as `DownOptions`
- Add corresponding flags to `downCliCommand` in `root-command.ts`
- Use `resolveWorktreePath()` to determine the working directory instead of `process.cwd()`
- Derive session name from resolved path

## TUI: `u` and `d` keybindings (Issue #54)

### `d` key: Down (kill tmux session)

- Available in Navigate and Expanded modes when cursor is on a worktree item or its detail rows
- Only active if the worktree has a live tmux session
- Adds a new `Mode.ConfirmDown` variant (separate from `ConfirmKill` which is for panes) carrying `sessionName`, `branch`, `worktreeKey`
- Shows confirmation: "Kill session for `<branch>`? [Enter/Esc]"
- On confirm: spawns `wct down --path <worktree-path>`, shows pending "stopping" state, refreshes sessions after completion
- On cancel (Esc): returns to previous mode (Navigate or Expanded)

### `u` key: Up modal

**New `UpModal` component** built with `TitledBox` and `ScrollableList`:

- **Profile selector**: scrollable list of available profiles, only shown if the repo has profiles defined
- **IDE toggle**: checkbox, default on
- **Attach toggle**: checkbox, default on (controls whether to auto-switch to the new session after creation)

**New `Mode.UpModal` variant** carrying worktree path, repo project, and repo path context.

**Behavior on submit:**
- Spawns `wct up --no-attach --path <worktree-path>` with selected options (profile, no-ide flags)
- Always passes `--no-attach` since we're inside the TUI
- If attach toggle is on: switches to the new tmux session after successful creation
- Shows pending "starting" state during spawn
- Refreshes sessions on completion

### StatusBar updates

- Add `u:up` and `d:down` hints to Navigate and Expanded mode status bars

## Post-implementation

- Close issues #53 and #54 after implementation is verified

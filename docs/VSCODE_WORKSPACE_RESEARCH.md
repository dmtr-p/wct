## Summary of VS Code Workspace & Extension Configuration

### Extension Configuration Files
- **`.vscode/extensions.json`** - Contains recommendations and unwanted recommendations, but does NOT automatically install or enable/disable extensions
- **`.vscode/settings.json`** - Workspace settings, but does NOT store extension enable/disable state
- Extensions are only suggestions; users must manually install them

### Extension Enable/Disable State Storage
- **Not stored in workspace files** - Cannot be version controlled or shared via git
- **Stored in VS Code's internal storage** at platform-specific locations:
  - Windows: `%APPDATA%\Code\User\workspaceStorage\<workspace-id>\state.vscdb`
  - macOS: `~/Library/Application Support/Code/User/workspaceStorage/<workspace-id>/state.vscdb`
  - Linux: `~/.config/Code/User/workspaceStorage/<workspace-id>/state.vscdb`
- Each workspace gets a unique workspace ID
- State is per-machine, not portable

### Workspace Storage Structure
- Each workspace has its own folder under `workspaceStorage/<workspace-id>/`
- Contains `workspace.json` file that maps the workspace ID to the actual folder path
- Format: `{"folder": "file:///absolute/path/to/workspace"}`
- Can be used to programmatically find workspace storage by searching these JSON files

### State Database Format
- **`.vscdb` files are SQLite databases**
- Contain an `ItemTable` with key-value pairs
- Extension states stored with keys like `extensionsIdentifiers/disabled` and `extensionsIdentifiers/enabled`
- Can be inspected with `sqlite3` command or programmatically
- Direct editing is risky due to caching and potential corruption

### Git Worktrees Issue
- Each git worktree is treated as a separate workspace with its own unique ID
- Extension states do NOT automatically transfer between main workspace and worktrees
- No built-in VS Code CLI command to get workspace ID
- State must be manually copied or recreated for each worktree

### Solutions for Extension State Transfer
1. **Manual copy** - Copy `state.vscdb` from main workspace storage to worktree storage
2. **VS Code Profiles** - Create project-specific profile, switch to it in worktrees (cleanest official solution)
3. **Dev Containers** - Use `.devcontainer/devcontainer.json` with extensions array (requires containers)
4. **Automated script** - Search `workspace.json` files, find IDs, copy state files

### Custom Configuration Directory
- **`--user-data-dir` flag** changes where ALL VS Code data is stored (settings, extensions, workspace storage, etc.)
- Works cross-platform (Windows, macOS, Linux)
- Each directory is completely independent and isolated
- Can create multiple profiles by using different directories
- Useful for work/personal separation or testing environments
- Can be made permanent via shell aliases, wrapper scripts, or desktop entries

### Key Limitations
- No declarative way to control extension states via files
- Workspace storage is intentionally kept out of version control
- Each machine/user maintains their own extension states
- Git worktrees require manual state synchronization

# TODO

## Planned Features

### Copy config enhancements
- [x] Support copying directories recursively (e.g., `.claude/`)
- [x] Support glob patterns (e.g., `.claude/**/*.json`)
- [x] Use Bun's `Glob` API for pattern matching

Example config:
```yaml
copy:
  - .env                      # exact file
  - .vscode/                  # directory (trailing slash)
  - .claude/**/*.json         # glob pattern
```

### Worktree enhancements
- [ ] Base branch option: `tab open feature-1 --base main` (default: current HEAD)

### Tmux config enhancements
- [ ] Support panes inside windows (currently only supports panes OR windows, not both)

Example config:
```yaml
tmux:
  windows:
    - name: "dev"
      split: "horizontal"
      panes:
        - command: "bun run dev"
        - command: "bun run watch"
    - name: "testing"
      panes:
        - command: "bun test --watch"
    - name: "shell"
      command: ""  # single pane, no splits
```

# TUI Pane Actions: Zoom & Kill

## Summary

Add zoom toggle and kill actions for individual tmux panes in the TUI's expanded worktree view, plus a visual indicator for zoomed panes.

## Data Layer

Add `zoomed: boolean` to `TmuxPaneInfo` by extending the `list-panes` format string with `#{window_zoomed_flag}`. Update `parsePaneListOutput` to parse the new column.

All panes in a zoomed window report `zoomed: true` (tmux exposes zoom at the window level). This is acceptable — the icon on any pane in the window signals that zoom mode is active.

## TmuxService

Two new methods:

- **`zoomPane(paneId: string)`** — executes `tmux resize-pane -Z -t <paneId>`. Toggles zoom on/off.
- **`killPane(paneId: string)`** — executes `tmux kill-pane -t <paneId>`. When the last pane in a window is killed, tmux removes the window automatically.

## useTmux Hook

Expose `zoomPane(paneId)` and `killPane(paneId)` callbacks matching the existing `jumpToPane` pattern — call through to `TmuxService`, swallow errors.

## TUI Interaction

### Keybindings (Expanded mode only, pane row selected)

- **`z`** — toggle zoom on the selected pane. Calls `zoomPane`, then `refreshSessions` to update indicators. No confirmation.
- **`x`** — kill the selected pane. Opens `ConfirmKill` mode for confirmation before executing.

### ConfirmKill Mode

New mode in `types.ts`:

```typescript
| { type: "ConfirmKill"; paneId: string; label: string; worktreeKey: string }
```

Replaces the StatusBar content with an inline confirmation prompt:

```
Kill pane editor:0 zsh?  enter:confirm  esc:cancel
```

- **Enter** — calls `killPane(paneId)`, refreshes sessions, returns to `Expanded` mode (preserving `worktreeKey`).
- **Escape** — returns to `Expanded` mode without action.

### StatusBar Updates

Expanded mode hints update to show `z:zoom  x:kill` when a pane detail row is selected. This requires passing the selected item type to StatusBar, or conditionally appending the hints.

## Visual: Zoom Indicator

When a pane has `zoomed: true`, prepend a magnifying glass icon in `DetailRow`:

```
        ▸ 🔍 editor:0 zsh
              editor:1 node
```

Implementation: add `zoomed?: boolean` to the `meta` field on `TreeItem` detail rows. `buildTreeItems` passes the value from `PaneInfo`. `DetailRow` renders the icon in yellow when `meta.zoomed` is truthy.

## Files Modified

| File | Change |
|------|--------|
| `src/services/tmux.ts` | Add `zoomed` to `TmuxPaneInfo`, add `zoomPane`/`killPane` to service, update format string and parser |
| `src/tui/hooks/useTmux.ts` | Expose `zoomPane` and `killPane` callbacks |
| `src/tui/types.ts` | Add `ConfirmKill` mode variant, update `meta` type with `zoomed` |
| `src/tui/App.tsx` | Handle `z`/`x` keys in expanded mode, add `ConfirmKill` input handler, pass zoomed to tree items |
| `src/tui/components/DetailRow.tsx` | Render zoom icon for zoomed panes |
| `src/tui/components/StatusBar.tsx` | Show pane-specific hints in expanded mode, render confirm kill prompt |

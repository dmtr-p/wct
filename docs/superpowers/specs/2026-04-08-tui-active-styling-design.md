# TUI Active Styling & Layout Improvements

## Summary

Three changes to the TUI tree view:

1. **Bold instead of inverse** for active/selected items
2. **Ellipsis truncation** for long branch names that exceed terminal width
3. **Git stats on second line**, only visible when branch is selected or expanded

## Changes

### 1. Active Styling

Remove `inverse={isSelected}` from `WorktreeItem` and `RepoNode`. Keep `bold={isSelected}` and `color={isSelected ? "cyan" : ...}`.

**Files:** `src/tui/components/WorktreeItem.tsx`, `src/tui/components/RepoNode.tsx`

### 2. Branch Name Truncation

`WorktreeItem` receives a `maxWidth` prop (terminal columns from `stdout.columns`).

Available space for the branch name is calculated by subtracting fixed-width elements:
- Prefix: 4 chars (`"❯   "` or `"    "`)
- Expand icon: 2 chars (when present)
- Indicator: 2 chars (`"● "` or `"○ "`)
- Attached marker: 2 chars (when present)
- Right margin buffer: 2 chars

If `branch.length` exceeds the available space, slice to `(available - 3)` and append `...`.

**Prop threading:** `App.tsx` reads `stdout.columns` (already has `useStdout()`), passes through `TreeView` props to `WorktreeItem`.

**Files:** `src/tui/App.tsx`, `src/tui/components/TreeView.tsx`, `src/tui/components/WorktreeItem.tsx`

### 3. Git Stats on Second Line

When `isSelected || isExpanded`, render sync status, changed files count, and notification count on a second `<Box>` row. When neither condition is true, hide stats entirely.

Second line layout:
```
❯   ● feature/my-branch *
        ↑2 ~3 !1
```

Indentation: 8 spaces (aligns past `"❯   ● "`).

Stats elements (only rendered when non-empty):
- Sync status (e.g., `↑2`)
- Changed files (e.g., `~3`)
- Notifications (e.g., `!1`)

If all stats are empty, no second line is rendered even when selected/expanded.

The `WorktreeItem` component changes from returning a single `<Box>` to returning a `<Box flexDirection="column">` wrapper containing the branch line and the optional stats line.

**Files:** `src/tui/components/WorktreeItem.tsx`

## Files Modified

| File | Change |
|------|--------|
| `src/tui/components/WorktreeItem.tsx` | Remove inverse, add truncation, add stats second line |
| `src/tui/components/RepoNode.tsx` | Remove inverse |
| `src/tui/components/TreeView.tsx` | Pass `maxWidth` to `WorktreeItem` |
| `src/tui/App.tsx` | Read `stdout.columns`, pass to `TreeView` |

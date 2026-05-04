# TUI Text Truncation — Design Spec

**Date:** 2026-05-04  
**Issue:** #69

## Problem

Project names in `RepoNode` and pane labels in `DetailRow` are rendered without any width cap. On narrow terminals they overflow into the next line, breaking the layout. Branch names in `WorktreeItem` already handle this correctly; this spec extends the same pattern to the two missing places.

## Scope

| Location | Element | Change |
|---|---|---|
| `RepoNode` | Project name | Add right-truncation with `...` |
| `DetailRow` — `pane` | `window:index command` | Prefix-preserving truncation on command |
| `DetailRow` — `pane-header` | `Panes (N)` | Right-truncation |
| `DetailRow` — `check` | Check name | Right-truncation |
| `DetailRow` — `pr` | PR title | **No change** |

## Design

### 1. Shared truncation utility — `src/tui/utils/truncate.ts`

Two exported functions:

```ts
// Right-truncates text to `available` chars, appending '...' if cut.
// Currently lives in WorktreeItem.tsx — moved here, import updated there.
export function truncateBranch(text: string, available: number): string

// Preserves `prefix` verbatim, truncates `rest` to fit within `available` total chars.
// Falls back to truncateBranch on the whole string when available is too narrow
// to show even a minimal suffix.
export function truncateWithPrefix(
  prefix: string,
  rest: string,
  available: number,
): string
```

`truncateWithPrefix` logic:
- If `prefix.length + rest.length <= available` → return `prefix + rest`
- If `available <= prefix.length + 3` → `truncateBranch(prefix + rest, available)`
- Otherwise → `prefix + truncateBranch(rest, available - prefix.length)`

`WorktreeItem.tsx` updates its import; no behavior change.

### 2. `RepoNode` — project name truncation

New prop: `maxWidth: number`.

`TreeView` already holds `maxWidth` and passes it to `WorktreeItem`; it now also passes it to `RepoNode`.

Overhead inside `RepoNode`:
- prefix (`"❯ "` / `"  "`) = 2 chars
- arrow (`"▼"` / `"▶"`) = 1 char
- space = 1 char
- **Total: 4 chars**

```ts
const displayProject = truncateBranch(project, maxWidth - 4);
```

### 3. `DetailRow` — pane and other item truncation

New prop: `maxWidth: number`. `TreeView` passes it down.

**`pane` items — prefix-preserving truncation**

The label currently pre-joins `window`, `paneIndex`, and `command` in `tree-helpers.ts`. To enable prefix-preserving truncation, the `meta` field on `"pane"` detail items is extended with two new fields:

```ts
meta: { paneId: string; zoomed?: boolean; active?: boolean; window: string; paneIndex: number; command: string }
```

`tree-helpers.ts` sets `meta.window` and `meta.paneIndex` from the raw `TmuxPaneInfo`. The `label` field is no longer needed for display (it's still set for keying); `DetailRow` reconstructs the prefix from `meta`.

Inside `DetailRow` for `pane`:
```
prefix  = `${meta.window}:${meta.paneIndex} `
rest    = meta.command  // stored separately on meta
overhead = indent(8) + selectorPrefix(2) + zoomedEmoji(3 if zoomed&&active else 0)
display = truncateWithPrefix(prefix, rest, maxWidth - overhead)
```

`meta` also stores `command: string` (from `TmuxPaneInfo.command`) so `DetailRow` can truncate it separately without parsing the `label` string.

**`pane-header` items**

```
overhead = indent(6) + selectorPrefix(2) = 8
display  = truncateBranch(label, maxWidth - 8)
```

**`check` items**

```
overhead = indent(8) + selectorPrefix(2) + icon+space(2) = 12
display  = truncateBranch(label, maxWidth - 12)
```

### 4. File changes summary

| File | Change |
|---|---|
| `src/tui/utils/truncate.ts` | **New** — `truncateBranch`, `truncateWithPrefix` |
| `src/tui/components/WorktreeItem.tsx` | Update import; remove local `truncateBranch` definition |
| `src/tui/components/RepoNode.tsx` | Add `maxWidth` prop; truncate project name |
| `src/tui/components/DetailRow.tsx` | Add `maxWidth` prop; truncate pane/pane-header/check labels |
| `src/tui/components/TreeView.tsx` | Pass `maxWidth` to `RepoNode` and `DetailRow` |
| `src/tui/types.ts` | Extend `"pane"` detail item `meta` with `window`, `paneIndex`, `command` |
| `src/tui/tree-helpers.ts` | Set new `meta` fields when building pane detail items |

## Testing

- Unit tests for `truncateBranch` and `truncateWithPrefix` in `src/tui/utils/truncate.test.ts`
- Cover: fits without truncation, exact fit, needs truncation, extremely narrow (available ≤ 3 / ≤ prefix+3)
- No component-level tests needed — the utility functions capture all the logic

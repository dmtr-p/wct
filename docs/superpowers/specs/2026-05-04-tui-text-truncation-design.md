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
| `StatusBar` kill-confirm label | `Kill pane …?` | **Out of scope** — tracked separately |

The kill-confirm status bar (`StatusBar` rendering `Kill pane ${mode.label}?`) can still overflow on very long pane commands. That path uses `mode.label` from `resolveSelectedPane`, which is a separate display surface. It is explicitly out of scope here and should be addressed in a follow-up.

## Design

### Truncation budget: string character length

All truncation in this spec — and in the existing `truncateBranch` used by `WorktreeItem` — operates on `String.prototype.length` (UTF-16 code units), not terminal display-column width. This is consistent with the existing pattern. Ink's `wrap="truncate"` is not used; manual truncation gives control over the `...` suffix and prefix-preservation logic. Wide unicode characters (emoji wider than 1 column) are not compensated for — same as the existing branch truncation.

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

**`pane` items — required meta fields**

The `"pane"` detail item meta is updated in `src/tui/types.ts` to make `window`, `paneIndex`, and `command` required (non-optional):

```ts
// Before
| DetailItem<"pane", { paneId: string; zoomed?: boolean; active?: boolean }>

// After
| DetailItem<"pane", {
    paneId: string;
    zoomed?: boolean;
    active?: boolean;
    window: string;
    paneIndex: number;
    command: string;
  }>
```

`tree-helpers.ts` already has all three values from `TmuxPaneInfo` when building pane detail items — it just needs to pass them into `meta`. Because they are typed as required and set at the single construction site, `DetailRow` can access `item.meta.window` etc. directly with no optional-chaining or unsafe assertions. No fallback to `item.label` is needed.

The `label` field continues to be set as `${pane.window}:${pane.paneIndex} ${pane.command}` (unchanged) — it is used as a fallback key in `getDetailRowKey` and for the kill-confirm `mode.label`.

**`pane` items — prefix-preserving truncation**

```
prefix   = `${meta.window}:${meta.paneIndex} `
rest     = meta.command
overhead = indent(8) + selectorPrefix(2) + zoomedEmoji(3 if zoomed&&active else 0)
display  = truncateWithPrefix(prefix, rest, maxWidth - overhead)
```

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
| `src/tui/types.ts` | Make `window`, `paneIndex`, `command` required on `"pane"` detail item meta |
| `src/tui/tree-helpers.ts` | Set new `meta` fields when building pane detail items |

## Testing

**Utility tests** — `src/tui/utils/truncate.test.ts`

- `truncateBranch`: fits without truncation, exact fit, needs truncation, extremely narrow (available ≤ 3)
- `truncateWithPrefix`: fits, prefix+rest fits exactly, rest needs truncation, extremely narrow (available ≤ prefix+3), empty command

**Component / render tests**

- `RepoNode`: renders truncated project name when `maxWidth` is tight; renders full name when width is sufficient
- `DetailRow` pane: window:index prefix is preserved when command is long; both prefix and command render when they fit
- `TreeView`: `maxWidth` prop reaches `RepoNode` and `DetailRow` (smoke test with a narrow width, verify no overflow in rendered output)

The component tests catch the wiring risks (forgetting to pass `maxWidth`, wrong overhead per row) that utility tests alone cannot detect.

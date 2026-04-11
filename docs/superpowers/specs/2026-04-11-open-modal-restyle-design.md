# Open Modal Restyle: Lazygit-Inspired Box Style

## Summary

Restyle the TUI open worktree modal to use a consistent lazygit-inspired visual style: rounded box-drawing characters with titles embedded in the top border. No flow or behavioral changes — purely visual.

## New Component: `TitledBox`

**File:** `src/tui/components/TitledBox.tsx`

A reusable component that renders box-drawing characters with an embedded title in the top border line.

### Visual

```
╭ Title ────────────────╮
│ children              │
╰───────────────────────╯
```

Focused (cyan border + bold title):
```
╭ Branch ───────────────╮
│ my-feature▎           │
╰───────────────────────╯
```

Unfocused (dim border + dim title):
```
╭ Base ─────────────────╮
│ main                  │
╰───────────────────────╯
```

### Props

| Prop | Type | Description |
|------|------|-------------|
| `title` | `string` | Label embedded in the top border |
| `isFocused` | `boolean` | `true` → cyan border/title; `false` → dim |
| `width` | `number` (optional) | Box width; if omitted, uses a sensible default |
| `children` | `ReactNode` | Content rendered inside the box |

### Rendering

1. **Top border:** `╭ ` + bold title + ` ` + repeated `─` to fill width + `╮`
2. **Content:** children rendered inside `│ ` ... ` │` padding
3. **Bottom border:** `╰` + repeated `─` + `╯`

The color of all border characters and the title text follows `isFocused`.

## Changes to Existing Components

### `Modal.tsx`

Replace Ink's `Box` with `borderStyle="round"` with `TitledBox`. The modal title (e.g. "Open Worktree", "Open Worktree — New Branch") becomes the `TitledBox` title. Remove the separate `Text` title child.

### `BracketInput` (in `OpenModal.tsx`)

Replace entirely. Instead of the `[ value ]` bracket style, render a `TitledBox` with the label as title, containing just the text value and blinking cursor.

Before:
```
Branch
[ my-feature▎ ]
```

After:
```
╭ Branch ───────────────╮
│ my-feature▎           │
╰───────────────────────╯
```

### `PromptArea` (in `OpenModal.tsx`)

Replace entirely. Instead of manual `───` separator lines, render a `TitledBox` with title "Prompt" containing the multiline text and cursor.

Before:
```
Prompt
───────────────────────────────
optional
───────────────────────────────
```

After:
```
╭ Prompt ───────────────╮
│ optional              │
│                       │
│                       │
╰───────────────────────╯
```

### `ModeSelector` (in `OpenModal.tsx`)

Wrap the mode options list in a `TitledBox` with title "Select mode".

Before:
```
▸ New Branch
  Open from PR
  Existing Branch
```

After:
```
╭ Select mode ──────────╮
│ ▸ New Branch          │
│   Open from PR        │
│   Existing Branch     │
╰───────────────────────╯
```

### `ScrollableList` usage in `FromPRForm` and `ExistingBranchForm`

Wrap the `ScrollableList` in a `TitledBox` with the appropriate title ("Select PR" or "Select Branch"). The filter line stays inside the box. Remove the separate `Text` label that currently sits above the list.

### Unchanged

- `ToggleRow` — stays as inline `[x] Label` / `[ ] Label`
- `SubmitButton` — stays as inline `▸ Submit`
- All keyboard handling, flow logic, step transitions
- `OpenModalResult` interface and submission logic
- `OpenModalProps` interface
- `StatusBar` hint text content (moves inside the outer `TitledBox`)

## Implementation Notes

- `TitledBox` needs to know the available width to fill `─` characters correctly. It can accept a `width` prop or measure from Ink's `useStdout().stdout.columns`.
- The content rows need to be padded/truncated to fit within the box width. Each child line is prefixed with `│ ` and suffixed with ` │`.
- Ink's `Box` component with `borderStyle` is no longer used for the modal or inputs — `TitledBox` replaces it everywhere in the modal.

# TUI Add Project Modal

## Summary

Add an "Add Project" modal to the TUI that lets users register new repos in the registry without leaving the TUI. The modal features a `PathInput` component with filesystem completion — as the user types a path, matching directories are shown in a dropdown list, similar to shell tab-completion but with visual feedback.

## Trigger

- **Keybinding:** `a` in Navigate mode opens the AddProjectModal
- New `AddProjectModal` mode added to the `Mode` union type in `types.ts`

## Modal Structure

Uses the existing `Modal` wrapper component. Three focusable fields navigated with Tab/Shift+Tab:

1. **Path** (required) — `PathInput` component with filesystem completion dropdown
2. **Name** (optional) — simple text input
3. **Submit** — focusable submit field, matching the `SessionOptionsSection` pattern from OpenModal/UpModal

## Field Navigation

| Key | Action |
|-----|--------|
| Tab | Move focus to next field (Path → Name → Submit) |
| Shift+Tab | Move focus to previous field |
| Enter (in Path) | Confirm path value, auto-advance focus to Name |
| Enter (on Submit) | Execute add project action |

When focus leaves the Path field (via Tab or Enter), the Name field is auto-populated with the directory basename if it's still empty. The Name field is editable afterward and does not update continuously.

## PathInput Component

A new reusable component: text input at the top, `ScrollableList` dropdown below (with `maxVisible={8}`).

### Completion Behavior

- As the user types, read the **parent directory** of the current input value and filter its children
  - Example: typing `/Users/dmtr/co` → reads `/Users/dmtr/`, filters entries starting with `co`
  - Only directories are shown (no files)
- Filesystem reads are debounced (~100ms) to avoid hammering on fast typing
- Reads use Effect + BunServices filesystem, run through `runTuiSilentPromise`
- `~` is displayed as-is in the input but expanded to `$HOME` for all filesystem reads and on submit
- If the parent directory doesn't exist, the dropdown is empty (no error shown)

### Navigation

| Key | Action |
|-----|--------|
| Type characters | Filter completions |
| Up/Down arrows | Select from completions list |
| Right arrow | Accept highlighted completion into input (appends `/` to keep drilling) |
| Backspace | Delete last character |
| Enter | Confirm the current path value, advance focus to Name field |

### Validation

- After each completion acceptance (Right arrow) or when the user stops typing (same ~100ms debounce), check `pathExists(expandedInput + "/.git")` via `runTuiSilentPromise`
- Show a green checkmark indicator when the current path is a valid git repo
- Submit is disabled until the path points to a valid git repo

## Integration

### New Mode

Add `AddProjectModal` to the `Mode` union in `types.ts`.

### Modal Actions

`useModalActions` gets:
- `prepareAddProjectModal()` — sets mode to `AddProjectModal`
- `handleAddProject(result: { path: string; name?: string })` — calls `RegistryService.register(expandedPath, name ?? basename(expandedPath))`, triggers tree refresh, returns to Navigate mode

### Keyboard Routing

In `App.tsx`, `a` key in Navigate mode calls `prepareAddProjectModal()`.

### Error Handling

- If path isn't a git repo: validation prevents submit (submit disabled)
- If registration fails (duplicate, permissions, etc.): show error via `useActionError`

## Out of Scope

- Remove project from TUI (CLI `wct projects remove` is sufficient for now)
- Directory scanning / discovery of repos in common locations
- fzf integration

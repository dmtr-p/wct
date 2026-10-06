---
status: accepted
---

# Mouse input uses the shared guarded Ink input hook

All TUI input listeners use `useGuardedInput` in
`src/tui/hooks/useGuardedInput.ts`. The hook reads mouse reports from the
strings delivered by Ink's `useInput`, consumes them before keyboard handlers
receive them, and dispatches recognized events through `onMouseEvent`.
Biome restricts direct `useInput` imports to this hook.

Ink owns stdin through its readable loop and input parser. On the normal
stdin path, it emits each complete SGR mouse sequence separately and strips
the leading ESC before calling `useInput`. The guard also handles concatenated
mouse sequences from Ink's bracketed-paste fallback. Legacy X10 reports are
consumed as a prefix followed by three payload bytes; they do not trigger
mouse actions.

`src/tui/input/mouse.ts` contains sequence recognition, parsing, and tree
hit-testing. `App.tsx` routes tree events, while `MouseClickable` and modal
lists handle their own component events. Every active guarded hook consumes
mouse reports, including reports that do not produce an action, so they
cannot become text-field input.

Keep parsing on Ink's input stream. A separate stdin data listener would
compete with Ink's readable loop for the same chunks. This depends on Ink's
handling of unrecognized CSI sequences; preserve the mouse parser and input
wiring checks when updating Ink.

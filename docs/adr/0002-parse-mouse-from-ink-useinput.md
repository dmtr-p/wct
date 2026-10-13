---
status: accepted
---

# Mouse input uses the shared guarded Ink input hook

All TUI input listeners use `useGuardedInput` in
`src/tui/hooks/useGuardedInput.ts`. Oxlint restricts direct `useInput` imports
to this hook. Keyboard events use Ink's input channel; mouse events use
`src/tui/input/terminal-input.ts` subscriptions.

Ink discards unrecognized control sequences before `useInput`, so the
terminal adapter observes mouse reports before Ink parses them.

`startTui` passes a read facade from `createTerminalInput` to Ink. Ink remains
the only stdin reader. The facade recognizes SGR reports across chunks and
broadcasts events between reads to preserve keyboard/mouse order. It forwards
SGR bytes for Ink to discard without adding an escape timeout.

Legacy X10 reports trigger no actions. The adapter removes their three raw
payload bytes before UTF-8 decoding; Ink discards only their CSI prefix and
would otherwise deliver coordinates as text. Stream events, raw mode, and
ref/unref stay on the source. Releasing raw mode or disposing the adapter
resets parser state; hook cleanup removes subscriptions.

Bracketed paste stays literal on Ink's paste channel. When no paste listener
exists, the shared hook handles the paste fallback: mouse-only strings
are swallowed and dispatched, while mixed strings remain keyboard input.

`src/tui/input/mouse.ts` owns parsing and tree hit-testing. `App.tsx` routes
tree events; `MouseClickable` and modal lists handle component events.

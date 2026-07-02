---
status: proposed
---

# Mouse input is parsed from Ink's `useInput` string, not a second stdin listener

`wct tui` reads terminal SGR mouse events (`\x1b[<…M/m`) by parsing them out of
the `input` string Ink already hands to the existing `useInput` handler — a
`parseSgrMouse` guard at the top of the dispatcher that consumes and `return`s
on any mouse sequence. It does **not** attach a second `stdin.on('data', …)`
listener.

Why: Ink 7.1.0 reads stdin via `stdin.addListener('readable', …)` plus a
`while ((chunk = stdin.read()) !== null)` drain loop and a stateful
`createInputParser()` (`node_modules/ink/build/components/App.js`,
`input-parser.js`), re-emitting each parsed event on an internal EventEmitter.
A second `data` listener flips the stream into flowing mode and **races Ink's
own `read()` loop for the same chunks**. Most reference implementations
(Gemini CLI, octofriend, zenobi-us/ink-mouse) use the second-listener pattern;
Gemini only gets away with it because it ships a *forked* ink. Verified on the
installed 7.1.0: a full SGR sequence survives intact as one `input` string
(`'[<0;45;12M'`, one leading ESC stripped), so parsing from `useInput` is both
correct and race-free, and Ink's `pending` buffer already reassembles
chunk-split sequences.

Trade-off: we depend on an Ink-internal detail (that an unrecognised CSI
sequence is forwarded verbatim to `useInput`). Recorded here so a future
contributor does not "clean this up" by adding a dedicated stdin listener and
re-introduce the read-loop race.

See `.scratch/tui-mouse-support/PRD.md` §6.2 and §10.

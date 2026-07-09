---
status: proposed
---

# Navigate/Expanded uses an independent scroll-offset viewport

To support a mouse wheel that scrolls the worktree tree without moving the
selection, `wct tui`'s Navigate and Expanded modes gain an **independent scroll
offset** (the viewport top is tracked separately from `selectedIndex`). This
deliberately diverges from the only other scroll model in the app —
`getVisibleWindow` (`src/tui/components/ScrollableList.tsx`), used by the modals,
which is **selection-anchored** (the visible window is a pure function of the
selection, with no independent offset).

We chose independent-offset because the conventional sidebar mental model is
"wheel scrolls content, selection stays put," which a selection-anchored window
cannot express (if the selection doesn't move, the window doesn't move). The
trade-off accepted: two scroll models now coexist in one codebase, keyboard
↑/↓ must become viewport-aware (auto-scroll the offset to keep the selection
visible), and the windowing/hit-testing must share an explicit `rows[]` model
because visual rows are not 1:1 with logical tree items.

Rejected alternative: reuse `getVisibleWindow` and have the wheel move the
selection. Simpler and no new state, but the wheel would not behave like a
conventional scroll.

See `.scratch/tui-mouse-support/PRD.md` §6.4 and §10.

---
status: accepted
---

# Tree and modal lists use independent scroll offsets

The worktree tree tracks its viewport offset independently of its selection.
The mouse wheel scrolls content without moving the selected item; keyboard
navigation moves the viewport only far enough to reveal the selected item.

`src/tui/tree-navigation.ts` owns the tree's selection, viewport, and saved
return positions. `buildTreeRows` in `src/tui/tree-helpers.ts` supplies the
visual rows shared by rendering, windowing, and mouse hit-testing, because a
logical tree item can occupy multiple terminal rows.

`src/tui/components/ScrollableList.tsx` also tracks an independent offset for
modal lists. Wheel scrolling leaves selection unchanged. Selection or filter
changes reveal the selected item; list size changes clamp the offset.
`getVisibleWindow` initializes the viewport, while `scrollToRevealListItem`
and `clampListScrollOffset` handle subsequent updates.

Keeping viewport and selection separate lets users browse with the wheel
without changing the target of a keyboard action. Both tree and modal lists
must clamp offsets when their contents or available height change.

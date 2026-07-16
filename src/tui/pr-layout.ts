// src/tui/pr-layout.ts
//
// PR detail rows are the ONE tree line allowed to wrap onto multiple terminal
// rows (the title is shown in full, never truncated). The visual-row model in
// `tree-helpers` is otherwise 1:1 with terminal rows, so a wrapped PR would
// shift every row below it and desync mouse hit-testing. To keep them aligned,
// BOTH the row model (`buildTreeRows`) and the renderer (`DetailRow`) wrap the
// label through this single pure helper — same input, same line breaks, so the
// counted rows and the rendered lines can never diverge.
//
// Column width is measured as terminal display width (`utils/display-width`):
// CJK and emoji glyphs count two columns, matching how Ink (via
// `string-width`) decides whether a line soft-wraps. That measurement is
// biased to never undercount, so a line this helper emits is never wider than
// its budget under Ink's measurement — and DetailRow renders label lines with
// wrap="truncate-end" as a backstop, so even a measurement disagreement could
// only clip a glyph, never add a terminal row.

import { wrapText } from "./utils/wrap-text";

/** Leading indent columns of a PR detail line. */
export const PR_INDENT = 5;
/** Selected rows use a background, so no selector glyph reserves columns. */
export const PR_SELECTOR = 0;
/** Rollup-icon columns ("✓ ") when a rollup state is present. */
export const PR_ICON = 2;

/**
 * Columns consumed before the PR label on its first line. Continuation lines
 * are indented by this same amount so the wrapped text aligns under the label.
 * DetailRow renders exactly this much leading chrome (indent + icon),
 * so `maxWidth - prLabelStart` is the true per-line budget for the label.
 */
export function prLabelStart(hasIcon: boolean): number {
  return PR_INDENT + PR_SELECTOR + (hasIcon ? PR_ICON : 0);
}

/**
 * Split a PR label into the terminal lines it occupies at `maxWidth`. Line 0 is
 * rendered after the indent/selector/icon; any further lines are continuation
 * lines indented by `prLabelStart` to align under line 0's label.
 */
export function wrapPrLabel(
  label: string,
  maxWidth: number,
  hasIcon: boolean,
): string[] {
  return wrapText(label, Math.max(1, maxWidth - prLabelStart(hasIcon)));
}

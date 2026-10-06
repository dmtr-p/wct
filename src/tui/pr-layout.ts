// src/tui/pr-layout.ts
//
// PR summaries with presentation metadata occupy one terminal row. Expanded
// titles wrap through `wrapPrTitle`; PR labels without presentation metadata
// wrap through `wrapPrLabel`. `buildTreeRows` computes the lines and passes
// each piece to `DetailRow`, keeping rendering and mouse hit-testing aligned.
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
/** Leading columns for nested title, fact, and candidate rows. */
export const PR_SUBROW_INDENT = 9;

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

/** Wrap an expanded PR title within its nested row's column budget. */
export function wrapPrTitle(title: string, maxWidth: number): string[] {
  return wrapText(title, Math.max(1, maxWidth - PR_SUBROW_INDENT));
}

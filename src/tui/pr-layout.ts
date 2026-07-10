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

import { displayWidth, graphemeWidths } from "./utils/display-width";

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
 * Greedy word-wrap `text` into lines no wider than `width` display columns
 * (CJK/emoji glyphs count 2). A word wider than `width` is hard-broken on
 * grapheme boundaries — never splitting a surrogate pair or an emoji ZWJ
 * sequence. Always returns at least one (possibly empty) line.
 */
function wrapWords(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const word of text.split(" ")) {
    let w = word;
    let wordWidth = displayWidth(word);
    if (wordWidth > width) {
      // Hard-break: flush the current line, emit full-width pieces, and carry
      // the final piece forward as this iteration's word.
      if (current !== "") {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      let piece = "";
      let pieceWidth = 0;
      for (const [grapheme, graphemeW] of graphemeWidths(word)) {
        if (piece !== "" && pieceWidth + graphemeW > width) {
          lines.push(piece);
          piece = "";
          pieceWidth = 0;
        }
        piece += grapheme;
        pieceWidth += graphemeW;
      }
      w = piece;
      wordWidth = pieceWidth;
    }
    if (current === "") {
      current = w;
      currentWidth = wordWidth;
    } else if (currentWidth + 1 + wordWidth <= width) {
      current += ` ${w}`;
      currentWidth += 1 + wordWidth;
    } else {
      lines.push(current);
      current = w;
      currentWidth = wordWidth;
    }
  }
  lines.push(current);
  return lines;
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
  return wrapWords(label, Math.max(1, maxWidth - prLabelStart(hasIcon)));
}

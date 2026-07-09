import { displayWidth, graphemeWidths } from "./display-width";

const ELLIPSIS = "…"; // 1 display column

/**
 * Truncate `text` to at most `available` terminal display columns, appending
 * an ellipsis when anything was cut. Widths are measured like Ink measures
 * them (CJK/emoji glyphs count 2 columns; see `display-width`): tree rows are
 * budgeted as exactly ONE visual row by `buildTreeRows`, so a label that
 * renders wider than its budget would soft-wrap and desync the viewport and
 * mouse hit-testing for every row below it. Cutting happens on grapheme
 * boundaries — never splitting a surrogate pair or emoji ZWJ sequence.
 */
export function truncateBranch(text: string, available: number): string {
  if (displayWidth(text) <= available) return text;
  if (available <= 0) return "";
  const budget = available - 1; // reserve the ellipsis column
  let out = "";
  let width = 0;
  for (const [grapheme, graphemeW] of graphemeWidths(text)) {
    if (width + graphemeW > budget) break;
    out += grapheme;
    width += graphemeW;
  }
  return `${out}${ELLIPSIS}`;
}

/**
 * Collapse a possibly multi-line string onto one line by squashing every
 * newline run (with surrounding indentation) to a single space. The TUI's
 * bottom-chrome budget counts each error line as EXACTLY one terminal row and
 * relies on wrap="truncate" for width — but truncation does not remove
 * embedded newlines, and stderr-derived messages (git's "fatal: …\nhint: …")
 * regularly contain them; an un-collapsed message renders extra rows,
 * overflows the fixed-height layout, and desyncs mouse hit-testing.
 */
export function toSingleLine(text: string): string {
  return text.replace(/[ \t]*\r?\n[\s]*/g, " ").trim();
}

export function truncateWithPrefix(
  prefix: string,
  rest: string,
  available: number,
): string {
  const prefixWidth = displayWidth(prefix);
  if (prefixWidth + displayWidth(rest) <= available) return prefix + rest;
  if (available <= prefixWidth + 1)
    return truncateBranch(prefix + rest, available);
  return prefix + truncateBranch(rest, available - prefixWidth);
}

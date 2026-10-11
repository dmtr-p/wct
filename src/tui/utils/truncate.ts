import { displayWidth, graphemeWidths } from "./display-width";

const ELLIPSIS = "…";

// Keep grapheme clusters intact; callers still need Ink truncation to prevent
// soft wrapping when the width approximation differs from the renderer.
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

// Ink truncation does not remove embedded newlines from process errors.
// Collapse them to preserve the footer's row budget and mouse hit-testing.
export function toSingleLine(text: string): string {
  return text.replace(/[ \t]*(?:\r\n|[\r\n])[\s]*/g, " ").trim();
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

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
// Column width is approximated by code-point count (matching the truncate
// helpers). That is exact for the ASCII text PR titles almost always contain,
// but a double-width glyph (CJK/emoji) renders wider than its code-point count,
// so Ink could soft-wrap a piece we counted as one line and re-introduce a
// smaller version of the desync. Fixing that needs a wcwidth measurement, which
// would pull in a dependency the project forbids (effect + platform-bun only),
// so it is a deliberately accepted limitation, not an oversight.

/** Leading indent columns of a PR detail line. */
export const PR_INDENT = 6;
/** Selector-prefix columns ("▸ " / "  "). */
export const PR_SELECTOR = 2;
/** Rollup-icon columns ("✓ ") when a rollup state is present. */
export const PR_ICON = 2;

/**
 * Columns consumed before the PR label on its first line. Continuation lines
 * are indented by this same amount so the wrapped text aligns under the label.
 * DetailRow renders exactly this much leading chrome (indent + selector + icon),
 * so `maxWidth - prLabelStart` is the true per-line budget for the label.
 */
export function prLabelStart(hasIcon: boolean): number {
  return PR_INDENT + PR_SELECTOR + (hasIcon ? PR_ICON : 0);
}

/**
 * Greedy word-wrap `text` into lines no wider than `width` columns. A word
 * longer than `width` is hard-broken on code-point boundaries (never splitting
 * a surrogate pair into lone halves). Code-point count is treated as column
 * width, matching the truncate helpers. Always returns at least one (possibly
 * empty) line.
 */
function wrapWords(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    // Code points, so a hard break never severs a surrogate pair.
    let chars = [...word];
    while (chars.length > width) {
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      lines.push(chars.slice(0, width).join(""));
      chars = chars.slice(width);
    }
    const w = chars.join("");
    const wLen = chars.length;
    if (current === "") {
      current = w;
    } else if ([...current].length + 1 + wLen <= width) {
      current += ` ${w}`;
    } else {
      lines.push(current);
      current = w;
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

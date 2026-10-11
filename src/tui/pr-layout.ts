// buildTreeRows and DetailRow share these line breaks for mouse hit-testing.
// DetailRow also truncates lines because width estimates can differ from Ink.

import { wrapText } from "./utils/wrap-text";

/** Leading indent columns of a PR detail line. */
export const PR_INDENT = 5;
/** Selected rows use a background, so no selector glyph reserves columns. */
export const PR_SELECTOR = 0;
/** Rollup-icon columns ("✓ ") when a rollup state is present. */
export const PR_ICON = 2;
/** Leading columns for nested title, fact, and candidate rows. */
export const PR_SUBROW_INDENT = 9;

/** Label and continuation lines share this indent. */
export function prLabelStart(hasIcon: boolean): number {
  return PR_INDENT + PR_SELECTOR + (hasIcon ? PR_ICON : 0);
}

export function wrapPrLabel(
  label: string,
  maxWidth: number,
  hasIcon: boolean,
): string[] {
  return wrapText(label, Math.max(1, maxWidth - prLabelStart(hasIcon)));
}

export function wrapPrTitle(title: string, maxWidth: number): string[] {
  return wrapText(title, Math.max(1, maxWidth - PR_SUBROW_INDENT));
}

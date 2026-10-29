// buildTreeRows and DetailRow share these line breaks for mouse hit-testing.
// DetailRow also truncates lines because width estimates can differ from Ink.

import { wrapText } from "./utils/wrap-text";

export const PR_SUBROW_INDENT = 9;

export function wrapPrTitle(title: string, maxWidth: number): string[] {
  return wrapText(title, Math.max(1, maxWidth - PR_SUBROW_INDENT));
}

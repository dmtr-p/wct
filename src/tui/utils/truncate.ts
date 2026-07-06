const ELLIPSIS = "…";

export function truncateBranch(text: string, available: number): string {
  if (text.length <= available) return text;
  if (available <= 0) return "";
  return `${text.slice(0, available - ELLIPSIS.length)}${ELLIPSIS}`;
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
  if (prefix.length + rest.length <= available) return prefix + rest;
  if (available <= prefix.length + ELLIPSIS.length)
    return truncateBranch(prefix + rest, available);
  return prefix + truncateBranch(rest, available - prefix.length);
}

const ELLIPSIS = "…";

export function truncateBranch(text: string, available: number): string {
  if (text.length <= available) return text;
  if (available <= 0) return "";
  return `${text.slice(0, available - ELLIPSIS.length)}${ELLIPSIS}`;
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

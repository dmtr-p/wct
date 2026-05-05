export function truncateBranch(text: string, available: number): string {
  if (text.length <= available) return text;
  if (available <= 3) return ".".repeat(Math.max(0, available));
  return `${text.slice(0, available - 3)}...`;
}

export function truncateWithPrefix(
  prefix: string,
  rest: string,
  available: number,
): string {
  if (prefix.length + rest.length <= available) return prefix + rest;
  if (available <= prefix.length + 3)
    return truncateBranch(prefix + rest, available);
  return prefix + truncateBranch(rest, available - prefix.length);
}

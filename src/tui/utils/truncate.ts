const ELLIPSIS = "…";
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function displayWidth(text: string): number {
  return Bun.stringWidth(text);
}

export function truncateBranch(text: string, available: number): string {
  if (displayWidth(text) <= available) return text;
  if (available <= 0) return "";

  const contentBudget = available - displayWidth(ELLIPSIS);
  let result = "";
  let resultWidth = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = displayWidth(segment);
    if (resultWidth + segmentWidth > contentBudget) break;
    result += segment;
    resultWidth += segmentWidth;
  }
  return `${result}${ELLIPSIS}`;
}

export function truncateWithPrefix(
  prefix: string,
  rest: string,
  available: number,
): string {
  const prefixWidth = displayWidth(prefix);
  if (prefixWidth + displayWidth(rest) <= available) return prefix + rest;
  if (available <= prefixWidth + displayWidth(ELLIPSIS))
    return truncateBranch(prefix + rest, available);
  return prefix + truncateBranch(rest, available - prefixWidth);
}

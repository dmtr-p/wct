export function resolveWctBin(): string {
  try {
    const bin = Bun.which("wct");
    if (bin) return bin;
  } catch {
    // ignore
  }
  // Fallback: resolve relative to this source file
  const entry = new URL("../../src/index.ts", import.meta.url).pathname;
  return `bun run ${entry}`;
}

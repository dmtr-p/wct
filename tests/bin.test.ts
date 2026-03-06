import { describe, expect, test } from "bun:test";
import { resolveWctBin } from "../src/utils/bin";

describe("resolveWctBin", () => {
  test("returns a string", () => {
    const result = resolveWctBin();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns either wct path or bun run fallback", () => {
    const result = resolveWctBin();
    // Either Bun.which found wct in PATH, or it falls back to bun run
    const isWhichResult = !result.startsWith("bun run ");
    const isFallback =
      result.startsWith("bun run ") && result.endsWith("index.ts");

    expect(isWhichResult || isFallback).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { resolveWctBin } from "../src/utils/bin";

describe("resolveWctBin", () => {
  test("returns a command object", () => {
    const result = resolveWctBin();
    expect(typeof result.cmd).toBe("string");
    expect(Array.isArray(result.args)).toBe(true);
    expect(result.cmd.length).toBeGreaterThan(0);
  });

  test("returns either wct path or bun run fallback", () => {
    const result = resolveWctBin();
    const isWhichResult = result.args.length === 0;
    const isFallback =
      result.cmd === "bun" &&
      result.args[0] === "run" &&
      result.args[1]?.endsWith("index.ts");

    expect(isWhichResult || isFallback).toBe(true);
  });
});

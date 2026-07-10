import { describe, expect, test } from "vitest";
import { prLabelStart, wrapPrLabel } from "../../src/tui/pr-layout";
import { displayWidth } from "../../src/tui/utils/display-width";

describe("displayWidth", () => {
  test("counts ASCII one column per character", () => {
    expect(displayWidth("PR #1: short (OPEN)")).toBe(19);
  });

  test("counts CJK glyphs two columns each", () => {
    expect(displayWidth("日本語")).toBe(6);
  });

  test("counts emoji two columns, including ZWJ sequences as one glyph", () => {
    expect(displayWidth("🎉")).toBe(2);
    expect(displayWidth("⚡")).toBe(2); // default emoji presentation, BMP
    expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2); // family: 4 code points joined by ZWJ
  });

  test("overcounts a combining-mark cluster rather than undercount", () => {
    // "e" + U+0301 renders 1 column; the deliberate safety bias counts every
    // multi-code-point grapheme as 2 so wrapping can never emit a line Ink
    // measures as wider than budgeted.
    expect(displayWidth("e\u0301")).toBe(2);
    // The precomposed single code point stays 1 column.
    expect(displayWidth("\u00e9")).toBe(1);
  });
});

describe("prLabelStart", () => {
  test("reserves the five-column indent with no cursor glyph", () => {
    expect(prLabelStart(false)).toBe(5);
  });

  test("reserves an extra 2 columns for the rollup icon", () => {
    expect(prLabelStart(true)).toBe(7);
  });
});

describe("wrapPrLabel", () => {
  test("keeps a short label on a single line", () => {
    expect(wrapPrLabel("PR #1: short (OPEN)", 80, true)).toEqual([
      "PR #1: short (OPEN)",
    ]);
  });

  test("wraps a long label onto multiple lines at word boundaries", () => {
    const lines = wrapPrLabel(
      "PR #1: a very long pull request title that certainly wraps (OPEN)",
      40,
      true,
    );
    expect(lines.length).toBeGreaterThan(1);
    const budget = 40 - prLabelStart(true);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(budget);
    }
    // No content is lost: joining the lines reproduces the label.
    expect(lines.join(" ")).toBe(
      "PR #1: a very long pull request title that certainly wraps (OPEN)",
    );
  });

  test("hard-breaks a single word longer than the budget", () => {
    const lines = wrapPrLabel("x".repeat(50), 20, false);
    const budget = 20 - prLabelStart(false);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(budget);
    }
    expect(lines.join("")).toBe("x".repeat(50));
  });

  test("never returns zero lines for an empty label", () => {
    expect(wrapPrLabel("", 80, false)).toEqual([""]);
  });

  test("wraps by display width, not code points, for a CJK title", () => {
    // budget = 15 columns; each glyph is 2 columns, so seven fit per line.
    const lines = wrapPrLabel("日本語のタイトル", 20, false);
    expect(lines).toEqual(["日本語のタイト", "ル"]);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(15);
    }
  });

  test("wraps emoji words by their two-column width", () => {
    // budget = 13 columns; the emoji word cannot share a line with "fix".
    const lines = wrapPrLabel("fix 🎉🎉🎉🎉🎉", 18, false);
    expect(lines).toEqual(["fix", "🎉🎉🎉🎉🎉"]);
  });

  test("never splits an emoji ZWJ sequence when hard-breaking", () => {
    const family = "👨‍👩‍👧‍👦"; // one grapheme (4 code points + ZWJs), 2 columns
    // budget = 7 columns; the unbroken word splits on grapheme boundaries.
    const lines = wrapPrLabel(family.repeat(4), 12, false);
    expect(lines).toEqual([family.repeat(3), family]);
  });
});

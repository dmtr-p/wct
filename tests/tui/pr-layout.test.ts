import { describe, expect, test } from "vitest";
import { prLabelStart, wrapPrLabel } from "../../src/tui/pr-layout";

describe("prLabelStart", () => {
  test("reserves indent(6) + selector(2) with no icon", () => {
    expect(prLabelStart(false)).toBe(8);
  });

  test("reserves an extra 2 columns for the rollup icon", () => {
    expect(prLabelStart(true)).toBe(10);
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
    // Each line must fit the label budget (maxWidth - prLabelStart = 30).
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
    // No content is lost: joining the lines reproduces the label.
    expect(lines.join(" ")).toBe(
      "PR #1: a very long pull request title that certainly wraps (OPEN)",
    );
  });

  test("hard-breaks a single word longer than the budget", () => {
    const lines = wrapPrLabel("x".repeat(50), 20, false);
    // budget = 20 - 8 = 12
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(12);
    }
    expect(lines.join("")).toBe("x".repeat(50));
  });

  test("never returns zero lines for an empty label", () => {
    expect(wrapPrLabel("", 80, false)).toEqual([""]);
  });
});

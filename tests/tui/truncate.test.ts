import { describe, expect, test } from "vitest";
import {
  toSingleLine,
  truncateBranch,
  truncateWithPrefix,
} from "../../src/tui/utils/truncate";

describe("truncateBranch", () => {
  test("returns text unchanged when it fits", () => {
    expect(truncateBranch("feat/auth", 20)).toBe("feat/auth");
  });

  test("returns text unchanged at exact limit", () => {
    expect(truncateBranch("feat/auth", 9)).toBe("feat/auth");
  });

  test("truncates with ellipsis when too long", () => {
    expect(truncateBranch("feature/very-long-branch-name", 15)).toBe(
      "feature/very-l…",
    );
  });

  test("uses one ellipsis glyph in the available budget", () => {
    expect(truncateBranch("feature/branch", 3)).toBe("fe…");
  });

  test("handles available less than the text length", () => {
    expect(truncateBranch("feature/branch", 2)).toBe("f…");
    expect(truncateBranch("feature/branch", 1)).toBe("…");
  });

  test("returns empty string when available is 0", () => {
    expect(truncateBranch("feature/branch", 0)).toBe("");
  });
});

describe("truncateWithPrefix", () => {
  test("returns prefix+rest when both fit", () => {
    expect(truncateWithPrefix("1:0 ", "vim", 20)).toBe("1:0 vim");
  });

  test("returns prefix+rest at exact limit", () => {
    // "1:0 vim" is 7 chars
    expect(truncateWithPrefix("1:0 ", "vim", 7)).toBe("1:0 vim");
  });

  test("preserves prefix and truncates rest when too long", () => {
    // prefix "1:0 " (4), rest "bun run dev --watch" (19), available 15
    // → "1:0 " + truncateBranch("bun run dev --watch", 11)
    // → "1:0 " + "bun run de…"
    expect(truncateWithPrefix("1:0 ", "bun run dev --watch", 15)).toBe(
      "1:0 bun run de…",
    );
  });

  test("preserves prefix when available is wider than prefix plus ellipsis", () => {
    // prefix "1:0 " (4), available 7 (> 4+1)
    // "1:0 " + truncateBranch("vim this is long", 3) → "1:0 vi…"
    expect(truncateWithPrefix("1:0 ", "vim this is long", 7)).toBe("1:0 vi…");
  });

  test("falls back to truncateBranch when available <= prefix.length + ellipsis", () => {
    // prefix "1:0 " (4), available 5 (= 4+1) — fallback
    // truncateBranch("1:0 vim this is long", 5) → "1:0 …"
    expect(truncateWithPrefix("1:0 ", "vim this is long", 5)).toBe("1:0 …");
  });

  test("handles empty rest", () => {
    expect(truncateWithPrefix("1:0 ", "", 10)).toBe("1:0 ");
    expect(truncateWithPrefix("1:0 ", "", 4)).toBe("1:0 ");
  });
});

describe("toSingleLine", () => {
  test("returns a single-line string unchanged", () => {
    expect(toSingleLine("fatal: not a git repository")).toBe(
      "fatal: not a git repository",
    );
  });

  test("collapses git-style multi-line stderr onto one line", () => {
    // The exact shape that breaks the one-row-per-error budget: wrap="truncate"
    // does not remove embedded newlines, so this MUST be collapsed before render.
    expect(toSingleLine("fatal: something went wrong\nhint: try again")).toBe(
      "fatal: something went wrong hint: try again",
    );
  });

  test("squashes CRLF, indentation after the break, and trailing newlines", () => {
    expect(toSingleLine("error: HTTP 502\r\n   advice: retry later\n")).toBe(
      "error: HTTP 502 advice: retry later",
    );
    expect(toSingleLine("a\n\n\nb")).toBe("a b");
  });
});

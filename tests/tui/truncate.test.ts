import { describe, expect, test } from "vitest";
import {
  displayWidth,
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

  test("truncates wide glyphs by terminal columns", () => {
    const result = truncateBranch("功能分支", 5);
    expect(result).toBe("功能…");
    expect(displayWidth(result)).toBe(5);
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

  test("preserves the prefix while truncating wide command glyphs", () => {
    const result = truncateWithPrefix("1:0 ", "开发服务器", 9);
    expect(result).toBe("1:0 开发…");
    expect(displayWidth(result)).toBe(9);
  });
});

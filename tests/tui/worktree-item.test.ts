import { describe, expect, test } from "vitest";
import { truncateBranch } from "../../src/tui/components/WorktreeItem";

describe("truncateBranch", () => {
  test("returns branch unchanged when it fits", () => {
    expect(truncateBranch("feat/auth", 20)).toBe("feat/auth");
  });

  test("returns branch unchanged when exactly at limit", () => {
    expect(truncateBranch("feat/auth", 9)).toBe("feat/auth");
  });

  test("truncates with ellipsis when too long", () => {
    expect(truncateBranch("feature/very-long-branch-name", 15)).toBe(
      "feature/very...",
    );
  });

  test("handles very small available space", () => {
    expect(truncateBranch("feature/branch", 3)).toBe("...");
  });

  test("handles available less than 3", () => {
    expect(truncateBranch("feature/branch", 2)).toBe("..");
    expect(truncateBranch("feature/branch", 1)).toBe(".");
  });
});

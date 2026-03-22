import { describe, expect, test } from "vitest";
import { formatChanges, formatSync } from "../../src/services/worktree-status";

describe("formatSync", () => {
  test("returns checkmark when in sync", () => {
    expect(formatSync({ ahead: 0, behind: 0 })).toBe("\u2713");
  });

  test("returns up arrow with count when ahead", () => {
    expect(formatSync({ ahead: 3, behind: 0 })).toBe("\u21913");
  });

  test("returns down arrow with count when behind", () => {
    expect(formatSync({ ahead: 0, behind: 2 })).toBe("\u21932");
  });

  test("returns both arrows when ahead and behind", () => {
    expect(formatSync({ ahead: 1, behind: 3 })).toBe("\u21911 \u21933");
  });

  test("returns ? when sync is null", () => {
    expect(formatSync(null)).toBe("?");
  });
});

describe("formatChanges", () => {
  test("returns singular for 1 file", () => {
    expect(formatChanges(1)).toBe("1 file");
  });

  test("returns plural for multiple files", () => {
    expect(formatChanges(3)).toBe("3 files");
  });
});

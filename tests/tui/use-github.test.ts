import { describe, expect, test } from "vitest";
import { parseGhPrList } from "../../src/services/github-service";

describe("parseGhPrList", () => {
  test("parses JSON output from gh pr list", () => {
    const json = JSON.stringify([
      {
        number: 34,
        title: "feat: TUI sidebar",
        state: "OPEN",
        headRefName: "feat/tui",
      },
      {
        number: 31,
        title: "fix: migration",
        state: "MERGED",
        headRefName: "fix/migrate",
      },
    ]);
    const result = parseGhPrList(json);
    expect(result).toHaveLength(2);
    expect(result[0]?.number).toBe(34);
    expect(result[0]?.title).toBe("feat: TUI sidebar");
    expect(result[0]?.state).toBe("OPEN");
    expect(result[0]?.headRefName).toBe("feat/tui");
    expect(result[0]?.rollupState).toBe(null);
    expect(result[1]?.number).toBe(31);
    expect(result[1]?.title).toBe("fix: migration");
    expect(result[1]?.state).toBe("MERGED");
    expect(result[1]?.headRefName).toBe("fix/migrate");
    expect(result[1]?.rollupState).toBe(null);
  });

  test("returns empty array for empty JSON", () => {
    expect(parseGhPrList("[]")).toEqual([]);
  });

  test("returns empty array for invalid JSON", () => {
    expect(parseGhPrList("not json")).toEqual([]);
  });
});

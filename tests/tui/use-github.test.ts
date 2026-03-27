import { describe, expect, test } from "vitest";
import {
  parseGhPrChecks,
  parseGhPrList,
} from "../../src/services/github-service";

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
    expect(result[0].number).toBe(34);
    expect(result[0].title).toBe("feat: TUI sidebar");
    expect(result[0].state).toBe("OPEN");
    expect(result[0].headRefName).toBe("feat/tui");
    expect(result[1].number).toBe(31);
    expect(result[1].title).toBe("fix: migration");
    expect(result[1].state).toBe("MERGED");
    expect(result[1].headRefName).toBe("fix/migrate");
  });

  test("returns empty array for empty JSON", () => {
    expect(parseGhPrList("[]")).toEqual([]);
  });

  test("returns empty array for invalid JSON", () => {
    expect(parseGhPrList("not json")).toEqual([]);
  });
});

describe("parseGhPrChecks", () => {
  test("parses JSON output from gh pr checks", () => {
    const json = JSON.stringify([
      { name: "build", state: "SUCCESS" },
      { name: "test", state: "FAILURE" },
    ]);
    const result = parseGhPrChecks(json);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "build", state: "SUCCESS" });
  });

  test("returns empty array for invalid JSON", () => {
    expect(parseGhPrChecks("")).toEqual([]);
  });
});

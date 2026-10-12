import { describe, expect, test } from "vitest";
import { normalizeGhPr } from "../../src/services/pr-discovery";
import {
  checkOutcome,
  checkSummary,
  type PrCheck,
} from "../../src/services/pr-model";

describe("PR check outcomes", () => {
  test.each([
    [{ state: "SUCCESS" }, "passed"],
    [{ state: "SKIPPED" }, "passed"],
    [{ state: "NEUTRAL" }, "passed"],
    [{ state: "FAILURE" }, "failed"],
    [{ state: "TIMED_OUT" }, "failed"],
    [{ state: "STARTUP_FAILURE" }, "failed"],
    [{ state: "IN_PROGRESS" }, "pending"],
    [{ state: "QUEUED" }, "pending"],
    [{ state: "PENDING" }, "pending"],
    [{ state: "ACTION_REQUIRED" }, "pending"],
    [{ state: "CANCELLED" }, "cancelled"],
    [{ state: "FUTURE_STATE_42" }, "unknown"],
    [{ status: "COMPLETED", conclusion: "SUCCESS" }, "passed"],
    [{ status: "COMPLETED", conclusion: "FAILURE" }, "failed"],
    [{ status: "COMPLETED", conclusion: "SKIPPED" }, "passed"],
    [{ status: "IN_PROGRESS", conclusion: null }, "pending"],
    [{ status: "IN_PROGRESS", conclusion: "SUCCESS" }, "pending"],
    [null, "unknown"],
    [undefined, "unknown"],
    ["string", "unknown"],
    [42, "unknown"],
  ] as const)("classifies %j as %s", (raw, expected) => {
    expect(checkOutcome(raw)).toBe(expected);
  });
});

describe("PR check summary", () => {
  test.each([
    [[], null],
    [["passed", "passed"], "success"],
    [["passed", "cancelled"], "unknown"],
    [["passed", "unknown"], "unknown"],
    [["passed", "pending"], "pending"],
    [["unknown", "pending"], "pending"],
    [["pending", "failed"], "failure"],
    [["unknown", "failed"], "failure"],
  ] as const)("summarizes %j as %s", (outcomes, expected) => {
    const checks: PrCheck[] = outcomes.map((outcome) => ({
      name: "test",
      outcome,
      required: null,
    }));
    expect(checkSummary(checks, true)).toBe(expected);
  });

  test("missing or incomplete check data stays unknown", () => {
    expect(checkSummary(null, true)).toBe("unknown");
    expect(checkSummary([], false)).toBe("unknown");
    expect(
      checkSummary([{ name: "test", outcome: "passed", required: true }], false),
    ).toBe("unknown");
  });
});

describe("GitHub PR normalization", () => {
  const rawPr = {
    number: 34,
    title: "feat: TUI sidebar",
    state: "OPEN",
    headRefName: "feat/tui",
  };

  test("normalizes mixed status contexts and check runs for the shared summary", () => {
    const facts = normalizeGhPr(
      {
        ...rawPr,
        statusCheckRollup: [
          { context: "build", state: "SUCCESS" },
          { name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
          { name: "test", status: "IN_PROGRESS", conclusion: "SUCCESS" },
          null,
        ],
      },
      "base/repo",
      123,
    );
    expect(facts).toMatchObject({
      ...rawPr,
      baseRepository: "base/repo",
      fetchedAt: 123,
      checks: [
        { name: "build", outcome: "passed", required: null },
        { name: "lint", outcome: "passed", required: null },
        { name: "test", outcome: "pending", required: null },
        { name: "unknown", outcome: "unknown", required: null },
      ],
    });
    if (!facts) throw new Error("Missing normalized PR");
    expect(checkSummary(facts.checks, true)).toBe("pending");
  });

  test.each([undefined, "not-an-array"])(
    "missing or malformed rollup %j stays unknown",
    (statusCheckRollup) => {
      const facts = normalizeGhPr(
        { ...rawPr, statusCheckRollup },
        "base/repo",
        123,
      );
      expect(facts?.checks).toBeNull();
      expect(facts?.checksComplete).toBe(false);
    },
  );

  test("preserves a known empty check list", () => {
    const facts = normalizeGhPr(
      { ...rawPr, statusCheckRollup: [] },
      "base/repo",
      123,
    );
    expect(facts?.checks).toEqual([]);
    if (!facts) throw new Error("Missing normalized PR");
    expect(checkSummary(facts.checks, true)).toBeNull();
  });

  test.each([
    null,
    {},
    { ...rawPr, state: "invalid" },
    { ...rawPr, number: "34" },
  ])("rejects malformed PR facts %j", (raw) => {
    expect(normalizeGhPr(raw, "base/repo", 123)).toBeNull();
  });
});

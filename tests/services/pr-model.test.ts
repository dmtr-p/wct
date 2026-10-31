import { describe, expect, test } from "vitest";
import { normalizeGhPr } from "../../src/services/pr-discovery";
import {
  checkOutcome,
  checkSummary,
  hydratePrFacts,
  type PrCheck,
  prIdentity,
} from "../../src/services/pr-model";
import { prFactEnumCases, prFacts } from "../helpers/pr";

test("PR identity uses the lowercase base repository and PR number", () => {
  const pr = prFacts({ baseRepository: "Base/Repo", number: 34 });
  expect(prIdentity(pr)).toBe("base/repo#34");
  expect(prIdentity(pr)).toBe(
    prIdentity({ ...pr, baseRepository: "base/repo" }),
  );
  expect(prIdentity(pr)).not.toBe(prIdentity({ ...pr, number: 35 }));
  expect(prIdentity(pr)).not.toBe(
    prIdentity({ ...pr, baseRepository: "fork/repo" }),
  );
});

describe("PR fact normalization boundaries", () => {
  test.each(prFactEnumCases)(
    "normalizes enum fields %j",
    (fields, expected) => {
      const identity = {
        baseRepository: "base/repo",
        number: 34,
        title: "Change",
        state: "OPEN",
        headRefName: "feature",
      };
      expect(hydratePrFacts({ ...identity, ...fields })).toMatchObject(
        expected,
      );
      expect(
        normalizeGhPr({ ...identity, ...fields }, "base/repo", 123),
      ).toMatchObject(expected);
    },
  );

  test("cache hydration preserves internal facts, timestamps, and errors", () => {
    const cached = prFacts({
      headRepository: "fork/repo",
      headOid: "cached-head",
      updatedAt: "2026-10-15T00:01:00Z",
      fetchedAt: 123,
      isMergeQueueEnabled: true,
      isQueued: true,
      checks: [
        { name: "required", outcome: "passed", required: true },
        { name: "optional", outcome: "cancelled", required: false },
        { name: "unknown", outcome: "unknown", required: null },
      ],
      lastError: "offline",
    });
    expect(hydratePrFacts({ ...cached, headRefOid: "network-head" })).toEqual(
      cached,
    );
  });

  test.each([
    null,
    {},
    { ...prFacts(), state: "FUTURE_STATE" },
    { ...prFacts(), number: "34" },
    { ...prFacts(), title: undefined },
  ])("cache hydration rejects malformed identity %j", (value) => {
    expect(hydratePrFacts(value)).toBeNull();
  });
});

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
      checkSummary(
        [{ name: "test", outcome: "passed", required: true }],
        false,
      ),
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

  test("discovery maps GitHub facts and initializes freshness independently", () => {
    const raw = {
      ...rawPr,
      headRepositoryOwner: { login: "fork" },
      headRepository: { name: "repo" },
      headRefOid: "network-head",
      headOid: "cached-head",
      statusCheckRollup: [{ context: "build", state: "SUCCESS" }],
      checksComplete: true,
      fetchedAt: 1,
      lastError: "cached error",
      isMergeQueueEnabled: true,
      isQueued: true,
    };
    expect(normalizeGhPr(raw, "base/repo", 123)).toMatchObject({
      baseRepository: "base/repo",
      headRepository: "fork/repo",
      headOid: "network-head",
      checks: [{ name: "build", outcome: "passed", required: null }],
      checksComplete: false,
      fetchedAt: 123,
      lastError: null,
      isMergeQueueEnabled: null,
      isQueued: null,
    });
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

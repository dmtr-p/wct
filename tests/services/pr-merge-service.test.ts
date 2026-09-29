import { describe, expect, test } from "vitest";
import {
  buildPrMutation,
  MERGE_METHODS,
  type MergeSnapshot,
  mergeEligibility,
  mergeSnapshotFingerprint,
  resolveMergeConfiguration,
  validateSubmission,
} from "../../src/services/pr-merge-service";
import type { PrFacts } from "../../src/services/pr-model";

function snapshot(
  overrides: Partial<PrFacts> = {},
  settings: Partial<MergeSnapshot> = {},
): MergeSnapshot {
  const pr: PrFacts = {
    baseRepository: "base/repo",
    number: 7,
    id: "PR-id",
    url: "https://github.com/base/repo/pull/7",
    title: "Change",
    state: "OPEN",
    isDraft: false,
    headRepository: "fork/repo",
    headRefName: "feature",
    headOid: "abc123",
    baseRefName: "main",
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    isMergeQueueEnabled: false,
    isQueued: false,
    updatedAt: null,
    checks: [{ name: "test", outcome: "passed", required: true }],
    checksComplete: true,
    fetchedAt: 1,
    lastError: null,
    ...overrides,
  };
  return {
    pr,
    queueRequired: false,
    methods: ["SQUASH", "REBASE", "MERGE"],
    configurationError: null,
    ...settings,
  };
}

describe("merge eligibility and routing", () => {
  test("positive queue signals survive unrelated settings failures", () => {
    expect(resolveMergeConfiguration(true, undefined, null)).toEqual({
      queueRequired: true,
      methods: null,
      configurationError: null,
    });
    expect(
      resolveMergeConfiguration(false, { mergeQueue: { id: "queue" } }, null),
    ).toMatchObject({ queueRequired: true });
    expect(
      resolveMergeConfiguration(false, undefined, ["merge_queue"]),
    ).toMatchObject({
      queueRequired: true,
    });
    expect(resolveMergeConfiguration(false, undefined, null)).toMatchObject({
      queueRequired: null,
      configurationError: "queue settings unreadable",
    });
  });
  test("offers only repository-enabled methods", () => {
    expect(mergeEligibility(snapshot({}, { methods: ["REBASE"] }))).toEqual({
      route: "direct",
      methods: ["REBASE"],
    });
    expect(mergeEligibility(snapshot({}, { methods: [] }))).toEqual({
      route: "unavailable",
      reason: "merge methods unavailable",
    });
  });
  test("queue branches never offer direct merge", () => {
    expect(mergeEligibility(snapshot({}, { queueRequired: true }))).toEqual({
      route: "queue",
    });
    expect(
      mergeEligibility(
        snapshot(
          {},
          {
            queueRequired: null,
            configurationError: "queue settings unreadable",
          },
        ),
      ),
    ).toEqual({ route: "unavailable", reason: "queue settings unreadable" });
  });
  test.each([
    [{ isDraft: true }],
    [{ state: "MERGED" }],
    [{ reviewDecision: "REVIEW_REQUIRED" }],
    [{ mergeable: "CONFLICTING" }],
    [{ checks: [{ name: "test", outcome: "failed", required: true }] }],
    [{ checksComplete: false }],
    [{ lastError: "offline" }],
  ] as const)("hides actions for %j", (changes) => {
    expect(mergeEligibility(snapshot(changes as Partial<PrFacts>))).toEqual({
      route: "ineligible",
    });
  });
  test("an optional failure can still be mergeable", () => {
    expect(
      mergeEligibility(
        snapshot({
          mergeStateStatus: "UNSTABLE",
          checks: [{ name: "optional", outcome: "failed", required: false }],
        }),
      ),
    ).toMatchObject({ route: "direct" });
  });
});

describe("confirmed submission", () => {
  test.each(["SQUASH", "REBASE", "MERGE"] as const)(
    "%s maps directly to GraphQL mergeMethod",
    (method) => {
      const query = buildPrMutation(snapshot().pr, "direct", method);
      expect(query).toContain(`mergeMethod: ${method}`);
      expect(query).toContain('expectedHeadOid: "abc123"');
      expect(query).not.toContain("AutoMerge");
      expect(MERGE_METHODS[method].label).toBeTruthy();
    },
  );
  test("queue submission has no method or auto-merge request", () => {
    const query = buildPrMutation(snapshot().pr, "queue");
    expect(query).toContain("enqueuePullRequest");
    expect(query).toContain('expectedHeadOid: "abc123"');
    expect(query).not.toContain("mergeMethod");
    expect(query).not.toContain("AutoMerge");
  });
  test.each([
    ["head", { headOid: "other" }],
    ["target", { baseRefName: "release" }],
    ["review", { reviewDecision: "REVIEW_REQUIRED" }],
    [
      "checks",
      { checks: [{ name: "test", outcome: "failed", required: true }] },
    ],
    ["draft", { isDraft: true }],
    ["lifecycle", { state: "CLOSED" }],
    ["merge state", { mergeStateStatus: "BLOCKED" }],
  ] as const)("rejects changed %s before mutation", (_name, change) => {
    const original = snapshot();
    expect(() =>
      validateSubmission(
        original,
        snapshot(change as Partial<PrFacts>),
        "SQUASH",
      ),
    ).toThrow(/changed/);
  });
  test("rejects a changed queue route or enabled method set", () => {
    const original = snapshot();
    expect(() =>
      validateSubmission(
        original,
        snapshot({}, { queueRequired: true }),
        "SQUASH",
      ),
    ).toThrow(/changed/);
    expect(() =>
      validateSubmission(
        original,
        snapshot({}, { methods: ["REBASE"] }),
        "SQUASH",
      ),
    ).toThrow(/changed/);
  });
  test("fingerprint excludes timestamps but includes eligibility facts", () => {
    expect(mergeSnapshotFingerprint(snapshot())).toBe(
      mergeSnapshotFingerprint(snapshot({ fetchedAt: 999 })),
    );
    expect(mergeSnapshotFingerprint(snapshot())).not.toBe(
      mergeSnapshotFingerprint(
        snapshot({ reviewDecision: "CHANGES_REQUESTED" }),
      ),
    );
  });
});

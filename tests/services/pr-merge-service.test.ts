import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import { describe, expect, test } from "vitest";
import {
  buildPrMutation,
  MERGE_METHODS,
  mergeEligibility,
  type MergeSnapshot,
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

const mergeMethods = ["SQUASH", "REBASE", "MERGE"] as const;
const eligibleSnapshots = Arbitrary.all({
  number: Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
  ),
  mergeStateStatus: Arbitrary.schema(
    Schema.Literals(["CLEAN", "UNSTABLE", "HAS_HOOKS"]),
  ),
  reviewDecision: Arbitrary.schema(Schema.NullOr(Schema.Literal("APPROVED"))),
  methodMask: Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 })),
  ),
  checks: Arbitrary.array(
    Arbitrary.schema(
      Schema.Struct({
        required: Schema.NullOr(Schema.Boolean),
        outcome: Schema.Literals([
          "passed",
          "failed",
          "pending",
          "cancelled",
          "unknown",
        ]),
      }),
    ),
    { maxLength: 8 },
  ),
}).pipe(
  Arbitrary.map(
    ({ number, mergeStateStatus, reviewDecision, methodMask, checks }) =>
      snapshot(
        {
          number,
          id: `PR-${number}`,
          headOid: `head-${number}`,
          mergeStateStatus,
          reviewDecision,
          checks: checks.map((check, index) => ({
            name: `check-${index}`,
            required: check.required,
            outcome: check.required === true ? "passed" : check.outcome,
          })),
        },
        {
          methods: mergeMethods.filter(
            (_method, index) => (methodMask & (1 << index)) !== 0,
          ),
        },
      ),
  ),
);

const disqualifyingFacts: Array<[string, Partial<PrFacts>]> = [
  ["fetch error", { lastError: "offline" }],
  ["incomplete checks", { checksComplete: false }],
  ["missing checks", { checks: null }],
  ["closed PR", { state: "CLOSED" }],
  ["merged PR", { state: "MERGED" }],
  ["draft", { isDraft: true }],
  ["unknown draft status", { isDraft: null }],
  ["missing PR identity", { id: "" }],
  ["missing head", { headOid: null }],
  ["empty head", { headOid: "" }],
  ["conflicts", { mergeable: "CONFLICTING" }],
  ["unknown mergeability", { mergeable: "UNKNOWN" }],
  ["missing mergeability", { mergeable: null }],
  ["blocked merge state", { mergeStateStatus: "BLOCKED" }],
  ["unknown merge state", { mergeStateStatus: "UNKNOWN" }],
  ["missing merge state", { mergeStateStatus: null }],
  ["requested changes", { reviewDecision: "CHANGES_REQUESTED" }],
  ["required review", { reviewDecision: "REVIEW_REQUIRED" }],
  ["already queued", { isQueued: true }],
  ...(["failed", "pending", "cancelled", "unknown"] as const).map(
    (outcome): [string, Partial<PrFacts>] => [
      `required check ${outcome}`,
      { checks: [{ name: "required", outcome, required: true }] },
    ],
  ),
];

describe("merge eligibility and routing", () => {
  it.prop(
    "offers enabled direct methods only while the eligible snapshot permits them",
    {
      baseline: eligibleSnapshots,
    },
    ({ baseline }) => {
      expect(mergeEligibility(baseline)).toEqual({
        route: "direct",
        methods: baseline.methods,
      });
      expect(
        mergeEligibility({ ...baseline, queueRequired: true, methods: null }),
      ).toEqual({ route: "queue" });
      expect(mergeEligibility({ ...baseline, queueRequired: null }).route).toBe(
        "unavailable",
      );
      expect(
        mergeEligibility({
          ...baseline,
          configurationError: "settings unreadable",
        }).route,
      ).toBe("unavailable");
      for (const methods of [null, []]) {
        expect(mergeEligibility({ ...baseline, methods }).route).toBe(
          "unavailable",
        );
      }
    },
    { arbitrary: { runs: 100, maxShrinks: 200 } },
  );

  it.prop(
    "each disqualifying fact blocks otherwise eligible direct and queue snapshots",
    {
      baseline: eligibleSnapshots,
    },
    ({ baseline }) => {
      expect(mergeEligibility(baseline).route).toBe("direct");
      for (const [fact, change] of disqualifyingFacts) {
        for (const queueRequired of [false, true]) {
          expect(
            mergeEligibility({
              ...baseline,
              queueRequired,
              pr: { ...baseline.pr, ...change },
            }),
            fact,
          ).toEqual({ route: "ineligible" });
        }
      }
    },
    { arbitrary: { runs: 100, maxShrinks: 200 } },
  );

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
  test("allows a mergeable PR with pre-receive hooks", () => {
    expect(
      mergeEligibility(snapshot({ mergeStateStatus: "HAS_HOOKS" })),
    ).toMatchObject({
      route: "direct",
    });
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

import { type PrFacts, prIdentity } from "../../src/services/pr-model";
import { derivePrPresentation } from "../../src/tui/pr-status";
import type { TreeItem } from "../../src/tui/types";

export const prFactEnumCases = [
  [
    { reviewDecision: "APPROVED", mergeable: "MERGEABLE" },
    { reviewDecision: "APPROVED", mergeable: "MERGEABLE" },
  ],
  [
    { reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING" },
    { reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING" },
  ],
  [
    { reviewDecision: "REVIEW_REQUIRED", mergeable: "UNKNOWN" },
    { reviewDecision: "REVIEW_REQUIRED", mergeable: "UNKNOWN" },
  ],
  [{}, { reviewDecision: null, mergeable: null }],
  [
    { reviewDecision: undefined, mergeable: undefined },
    { reviewDecision: null, mergeable: null },
  ],
  [
    { reviewDecision: null, mergeable: null },
    { reviewDecision: null, mergeable: null },
  ],
  [
    { reviewDecision: "", mergeable: "" },
    { reviewDecision: null, mergeable: null },
  ],
  [
    { reviewDecision: "FUTURE_REVIEW", mergeable: "FUTURE_MERGEABLE" },
    { reviewDecision: null, mergeable: null },
  ],
  [
    { reviewDecision: "MERGEABLE", mergeable: "APPROVED" },
    { reviewDecision: null, mergeable: null },
  ],
  [
    { reviewDecision: true, mergeable: 1 },
    { reviewDecision: null, mergeable: null },
  ],
  [
    { reviewDecision: ["APPROVED"], mergeable: { value: "MERGEABLE" } },
    { reviewDecision: null, mergeable: null },
  ],
] as const;

export function prFacts(overrides: Partial<PrFacts> = {}): PrFacts {
  const number = overrides.number ?? 42;
  const baseRepository = overrides.baseRepository ?? "owner/repo";
  return {
    baseRepository,
    number,
    id: `PR_${number}`,
    url: `https://github.com/${baseRepository}/pull/${number}`,
    title: "Fix login",
    state: "OPEN",
    isDraft: false,
    headRepository: baseRepository,
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
}

export function prRowMeta(
  pr = prFacts(),
  prKey = prIdentity(pr),
): Extract<TreeItem, { detailKind: "pr" }>["meta"] {
  return {
    pr,
    prKey,
    presentation: derivePrPresentation(pr),
    expanded: false,
  };
}

import { type PrFacts, prIdentity } from "../../src/services/pr-model";
import { derivePrPresentation } from "../../src/tui/pr-status";
import type { TreeItem } from "../../src/tui/types";

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

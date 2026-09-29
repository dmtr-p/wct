/** Facts shared by GitHub fetching, SQLite, and the TUI. Missing facts stay unknown. */
export type PrLifecycle = "OPEN" | "MERGED" | "CLOSED";
export type CheckOutcome =
  | "passed"
  | "failed"
  | "pending"
  | "cancelled"
  | "unknown";

export interface PrCheck {
  name: string;
  outcome: CheckOutcome;
  required: boolean | null;
}

export interface PrFacts {
  baseRepository: string;
  number: number;
  id: string;
  url: string;
  title: string;
  state: PrLifecycle;
  isDraft: boolean | null;
  headRepository: string | null;
  headRefName: string;
  headOid: string | null;
  baseRefName: string | null;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  mergeStateStatus: string | null;
  isMergeQueueEnabled: boolean | null;
  isQueued: boolean | null;
  updatedAt: string | null;
  checks: PrCheck[] | null;
  checksComplete: boolean;
  fetchedAt: number;
  lastError: string | null;
}

export interface CheckCounts {
  passed: number;
  failed: number;
  pending: number;
  cancelled: number;
  unknown: number;
}

export function checkOutcome(raw: unknown): CheckOutcome {
  if (!raw || typeof raw !== "object") return "unknown";
  const check = raw as Record<string, unknown>;
  const state =
    typeof check.state === "string"
      ? check.state
      : check.status === "COMPLETED"
        ? check.conclusion
        : check.status;
  if (
    state === "FAILURE" ||
    state === "TIMED_OUT" ||
    state === "STARTUP_FAILURE"
  )
    return "failed";
  if (
    state === "IN_PROGRESS" ||
    state === "QUEUED" ||
    state === "PENDING" ||
    state === "ACTION_REQUIRED" ||
    state === "WAITING" ||
    state === "REQUESTED"
  )
    return "pending";
  if (state === "CANCELLED") return "cancelled";
  if (
    state === "SUCCESS" ||
    state === "SKIPPED" ||
    state === "NEUTRAL" ||
    state === "EXPECTED"
  )
    return "passed";
  return "unknown";
}

export function countChecks(checks: readonly PrCheck[]): CheckCounts {
  const counts: CheckCounts = {
    passed: 0,
    failed: 0,
    pending: 0,
    cancelled: 0,
    unknown: 0,
  };
  for (const check of checks) counts[check.outcome]++;
  return counts;
}

export function checkSummary(
  checks: readonly PrCheck[] | null,
  complete: boolean,
): "success" | "failure" | "pending" | "unknown" | null {
  if (!checks || !complete) return "unknown";
  if (checks.length === 0) return null;
  const counts = countChecks(checks);
  if (counts.failed) return "failure";
  if (counts.pending) return "pending";
  if (counts.cancelled || counts.unknown) return "unknown";
  return "success";
}

/** Cache hydration never turns omitted fields into success or readiness. */
export function hydratePrFacts(value: unknown): PrFacts | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<PrFacts>;
  if (
    typeof p.baseRepository !== "string" ||
    typeof p.number !== "number" ||
    typeof p.title !== "string" ||
    typeof p.headRefName !== "string"
  )
    return null;
  if (p.state !== "OPEN" && p.state !== "MERGED" && p.state !== "CLOSED")
    return null;
  return {
    baseRepository: p.baseRepository,
    number: p.number,
    id: typeof p.id === "string" ? p.id : "",
    url: typeof p.url === "string" ? p.url : "",
    title: p.title,
    state: p.state,
    isDraft: typeof p.isDraft === "boolean" ? p.isDraft : null,
    headRepository:
      typeof p.headRepository === "string" ? p.headRepository : null,
    headRefName: p.headRefName,
    headOid: typeof p.headOid === "string" ? p.headOid : null,
    baseRefName: typeof p.baseRefName === "string" ? p.baseRefName : null,
    reviewDecision:
      p.reviewDecision === "APPROVED" ||
      p.reviewDecision === "CHANGES_REQUESTED" ||
      p.reviewDecision === "REVIEW_REQUIRED"
        ? p.reviewDecision
        : null,
    mergeable:
      p.mergeable === "MERGEABLE" ||
      p.mergeable === "CONFLICTING" ||
      p.mergeable === "UNKNOWN"
        ? p.mergeable
        : null,
    mergeStateStatus:
      typeof p.mergeStateStatus === "string" ? p.mergeStateStatus : null,
    isMergeQueueEnabled:
      typeof p.isMergeQueueEnabled === "boolean" ? p.isMergeQueueEnabled : null,
    isQueued: typeof p.isQueued === "boolean" ? p.isQueued : null,
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
    checks: Array.isArray(p.checks)
      ? p.checks.map((check) => ({
          name: typeof check.name === "string" ? check.name : "unknown",
          outcome:
            check.outcome === "passed" ||
            check.outcome === "failed" ||
            check.outcome === "pending" ||
            check.outcome === "cancelled"
              ? check.outcome
              : "unknown",
          required: typeof check.required === "boolean" ? check.required : null,
        }))
      : null,
    checksComplete: p.checksComplete === true,
    fetchedAt: typeof p.fetchedAt === "number" ? p.fetchedAt : 0,
    lastError: typeof p.lastError === "string" ? p.lastError : null,
  };
}

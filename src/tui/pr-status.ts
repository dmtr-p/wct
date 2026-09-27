import { checkSummary, countChecks, type PrFacts } from "../services/pr-model";
import { displayWidth } from "./utils/display-width";
import { truncateBranch } from "./utils/truncate";

export const PR_COLORS = {
  green: "#40a02b",
  red: "#d20f39",
  yellow: "#df8e1d",
  mauve: "#8839ef",
  muted: "#6c6f85",
} as const;

export type PrTone = keyof typeof PR_COLORS;
export interface PrPresentation {
  primary: string;
  tone: PrTone;
  bold: boolean;
  checks: "success" | "failure" | "pending" | "unknown" | null;
  details: { key: string; text: string }[];
  stale: boolean;
}

function plural(count: number, label: string): string {
  return `${count} ${label}`;
}

export function derivePrPresentation(pr: PrFacts): PrPresentation {
  const checks = checkSummary(pr.checks, pr.checksComplete);
  const required = pr.checks?.filter((check) => check.required === true) ?? [];
  const requiredCounts = countChecks(required);
  const all = countChecks(pr.checks ?? []);
  const stale = pr.lastError !== null || !pr.checksComplete;
  const conflict =
    pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY";
  const blocked = pr.mergeStateStatus === "BLOCKED";
  const behind = pr.mergeStateStatus === "BEHIND";
  const queued = pr.isQueued === true;
  const requiredFailure = requiredCounts.failed > 0;
  const reviewPending = pr.reviewDecision === "REVIEW_REQUIRED";
  const requiredPending = requiredCounts.pending > 0;
  const readyEvidence =
    (pr.mergeStateStatus === "CLEAN" || pr.mergeStateStatus === "UNSTABLE") &&
    pr.mergeable === "MERGEABLE";
  const ready =
    readyEvidence &&
    !requiredFailure &&
    !requiredPending &&
    !reviewPending &&
    pr.reviewDecision !== "CHANGES_REQUESTED" &&
    !conflict &&
    !behind &&
    !blocked &&
    !queued &&
    pr.isDraft === false;

  let primary = "unknown";
  let tone: PrTone = "muted";
  let bold = false;
  if (pr.state === "MERGED") [primary, tone, bold] = ["merged", "mauve", true];
  else if (pr.state === "CLOSED") [primary, tone] = ["closed", "muted"];
  else if (pr.isDraft) [primary, tone] = ["draft", "muted"];
  else if (conflict) [primary, tone, bold] = ["conflicts", "red", true];
  else if (pr.reviewDecision === "CHANGES_REQUESTED")
    [primary, tone, bold] = ["changes requested", "yellow", true];
  else if (queued) [primary, tone] = ["queued", "yellow"];
  else if (requiredFailure)
    [primary, tone, bold] = ["checks failed", "red", true];
  else if (behind) [primary, tone] = ["behind base", "yellow"];
  else if (reviewPending) [primary, tone] = ["awaiting review", "yellow"];
  else if (requiredPending || checks === "pending")
    [primary, tone] = ["checks pending", "yellow"];
  else if (blocked) [primary, tone] = ["blocked", "muted"];
  else if (ready) [primary, tone, bold] = ["ready", "green", true];
  else if (pr.mergeable === "UNKNOWN")
    [primary, tone] = ["checking…", "yellow"];
  else if (pr.mergeStateStatus === "UNKNOWN" || pr.mergeStateStatus === null)
    [primary, tone] = ["unknown", "muted"];
  else [primary, tone] = ["open", "muted"];

  const details: PrPresentation["details"] = [{ key: "title", text: pr.title }];
  const review =
    pr.reviewDecision === "CHANGES_REQUESTED"
      ? "changes requested"
      : pr.reviewDecision === "REVIEW_REQUIRED"
        ? "awaiting review"
        : pr.reviewDecision === "APPROVED"
          ? "approved"
          : "not required / unknown";
  details.push({ key: "review", text: `Review: ${review}` });
  if (pr.checks === null || !pr.checksComplete) {
    details.push({ key: "checks", text: "Checks: unknown" });
  } else if (pr.checks.length === 0) {
    details.push({ key: "checks", text: "Checks: none" });
  } else {
    const parts: string[] = [];
    if (all.passed) parts.push(plural(all.passed, "passed"));
    if (requiredCounts.failed)
      parts.push(plural(requiredCounts.failed, "required failed"));
    if (all.failed - requiredCounts.failed)
      parts.push(
        plural(
          all.failed - requiredCounts.failed,
          "optional or unclassified failed",
        ),
      );
    if (all.pending) parts.push(plural(all.pending, "pending"));
    if (all.cancelled) parts.push(plural(all.cancelled, "cancelled"));
    if (all.unknown) parts.push(plural(all.unknown, "unknown"));
    details.push({ key: "checks", text: `Checks: ${parts.join(", ")}` });
  }
  let merge = "unknown";
  if (pr.state === "MERGED") merge = "merged";
  else if (pr.state === "CLOSED") merge = "closed";
  else if (pr.isDraft) merge = "blocked (draft)";
  else if (conflict) merge = "blocked (conflicts)";
  else if (pr.reviewDecision === "CHANGES_REQUESTED")
    merge = "blocked (changes requested)";
  else if (requiredFailure) merge = "blocked (required checks failed)";
  else if (reviewPending) merge = "blocked (review required)";
  else if (behind) merge = "blocked (behind base)";
  else if (queued) merge = "queued";
  else if (blocked) merge = "blocked";
  else if (ready) merge = "ready";
  else if (pr.mergeable === "UNKNOWN") merge = "checking…";
  details.push({ key: "merge", text: `Merge: ${merge}` });
  if (stale) {
    const updated = pr.fetchedAt
      ? new Date(pr.fetchedAt).toLocaleString()
      : "unknown";
    details.push({
      key: "updated",
      text: `Updated: ${updated} — ${pr.lastError ?? "incomplete data"}`,
    });
  }
  return {
    primary,
    tone,
    bold,
    checks: pr.state === "OPEN" ? checks : null,
    details,
    stale,
  };
}

/** Exactly one terminal row, preserving freshness ahead of status at narrow widths. */
export function compactPrText(
  number: number,
  presentation: PrPresentation,
  width: number,
  expanded = false,
): string {
  const prefix = `     ${expanded ? "▾" : "▸"} ${number > 0 ? `#${number}` : "#?"}`;
  const stale = presentation.stale ? " · stale" : "";
  const icon =
    presentation.checks === "success"
      ? "✓"
      : presentation.checks === "failure"
        ? "✗"
        : presentation.checks === "pending"
          ? "◌"
          : presentation.checks === "unknown"
            ? "?"
            : "";
  const check = icon ? ` · checks ${icon}` : "";
  const full = `${prefix}  ${presentation.primary}${check}${stale}`;
  if (displayWidth(full) <= width) return full;
  const withoutChecks = `${prefix}  ${presentation.primary}${stale}`;
  if (displayWidth(withoutChecks) <= width) return withoutChecks;
  if (presentation.stale) {
    const short = `#${number} stale`;
    const indent = " ".repeat(Math.max(0, width - displayWidth(short)));
    return truncateBranch(`${indent}${short}`, width);
  }
  return truncateBranch(`${prefix}  ${presentation.primary}`, width);
}

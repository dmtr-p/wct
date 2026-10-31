import {
  type CheckCounts,
  checkSummary,
  countChecks,
  type PrFacts,
} from "../services/pr-model";
import { displayWidth, graphemeWidths } from "./utils/display-width";
import { toSingleLine } from "./utils/truncate";

export const PR_COLORS = {
  green: "#40a02b",
  red: "#d20f39",
  yellow: "#df8e1d",
  mauve: "#8839ef",
  muted: "#6c6f85",
} as const;

export type PrTone = keyof typeof PR_COLORS;
export type PrPrimaryStatus =
  | "merged"
  | "closed"
  | "draft"
  | "conflicts"
  | "changes requested"
  | "queued"
  | "checks failed"
  | "behind base"
  | "awaiting review"
  | "checks pending"
  | "blocked"
  | "ready"
  | "checking…"
  | "unknown"
  | "open";

export interface PrPresentation {
  primary: PrPrimaryStatus;
  tone: PrTone;
  bold: boolean;
  checks: "success" | "failure" | "pending" | "unknown" | null;
  details: { key: string; text: string }[];
  stale: boolean;
}

const PR_MERGE_DESCRIPTIONS = {
  merged: "merged",
  closed: "closed",
  draft: "blocked (draft)",
  conflicts: "blocked (conflicts)",
  "changes requested": "blocked (changes requested)",
  queued: "queued",
  "checks failed": "blocked (required checks failed)",
  "behind base": "blocked (behind base)",
  "awaiting review": "blocked (review required)",
  "checks pending": "checks pending",
  blocked: "blocked",
  ready: "ready",
  "checking…": "checking…",
  unknown: "unknown",
  open: "open",
} satisfies Record<PrPrimaryStatus, string>;

function plural(count: number, label: string): string {
  return `${count} ${label}`;
}

export function candidatePrLabel(pr: PrFacts): string {
  return `#${pr.number} ${pr.title} · ${pr.headRepository ?? "unknown head"} · ${pr.state.toLowerCase()}`;
}

function classifyPrPrimary(
  pr: PrFacts,
  checks: PrPresentation["checks"],
  requiredCounts: CheckCounts,
): Pick<PrPresentation, "primary" | "tone" | "bold"> {
  if (pr.state === "MERGED")
    return { primary: "merged", tone: "mauve", bold: true };
  if (pr.state === "CLOSED")
    return { primary: "closed", tone: "muted", bold: false };
  if (pr.isDraft) return { primary: "draft", tone: "muted", bold: false };
  const conflict =
    pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY";
  if (conflict) return { primary: "conflicts", tone: "red", bold: true };
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return { primary: "changes requested", tone: "yellow", bold: true };
  if (pr.isQueued === true)
    return { primary: "queued", tone: "yellow", bold: false };
  if (requiredCounts.failed > 0)
    return { primary: "checks failed", tone: "red", bold: true };
  if (pr.mergeStateStatus === "BEHIND")
    return { primary: "behind base", tone: "yellow", bold: false };
  if (pr.reviewDecision === "REVIEW_REQUIRED")
    return { primary: "awaiting review", tone: "yellow", bold: false };
  if (requiredCounts.pending > 0 || checks === "pending")
    return { primary: "checks pending", tone: "yellow", bold: false };
  if (pr.mergeStateStatus === "BLOCKED")
    return { primary: "blocked", tone: "muted", bold: false };
  if (checks === "unknown")
    return { primary: "unknown", tone: "muted", bold: false };
  const readyEvidence =
    (pr.mergeStateStatus === "CLEAN" || pr.mergeStateStatus === "UNSTABLE") &&
    pr.mergeable === "MERGEABLE";
  if (readyEvidence && pr.isDraft === false)
    return { primary: "ready", tone: "green", bold: true };
  if (pr.mergeable === "UNKNOWN")
    return { primary: "checking…", tone: "yellow", bold: false };
  if (pr.mergeStateStatus === "UNKNOWN" || pr.mergeStateStatus === null)
    return { primary: "unknown", tone: "muted", bold: false };
  return { primary: "open", tone: "muted", bold: false };
}

export function derivePrPresentation(pr: PrFacts): PrPresentation {
  const checks = checkSummary(pr.checks, pr.checksComplete);
  const required = pr.checks?.filter((check) => check.required === true) ?? [];
  const requiredCounts = countChecks(required);
  const all = countChecks(pr.checks ?? []);
  const stale = pr.lastError !== null || !pr.checksComplete;
  const { primary, tone, bold } = classifyPrPrimary(pr, checks, requiredCounts);
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
  const merge = PR_MERGE_DESCRIPTIONS[primary];
  details.push({ key: "merge", text: `Merge: ${merge}` });
  if (stale) {
    const updated = pr.fetchedAt
      ? new Date(pr.fetchedAt).toLocaleString()
      : "unknown";
    details.push({
      key: "updated",
      text: `Updated: ${updated} — ${toSingleLine(pr.lastError ?? "incomplete data")}`,
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

export type PrTextSegment = {
  text: string;
  kind: "plain" | "number" | "status" | "checks" | "stale";
};

function truncateSegments(
  segments: PrTextSegment[],
  width: number,
): PrTextSegment[] {
  if (displayWidth(segments.map((segment) => segment.text).join("")) <= width)
    return segments;
  if (width <= 0) return [];
  const result: PrTextSegment[] = [];
  let remaining = width - 1;
  for (const segment of segments) {
    let text = "";
    for (const [grapheme, graphemeWidth] of graphemeWidths(segment.text)) {
      if (graphemeWidth > remaining) break;
      text += grapheme;
      remaining -= graphemeWidth;
    }
    if (text) result.push({ ...segment, text });
    if (text !== segment.text || remaining === 0) break;
  }
  result.push({ text: "…", kind: "plain" });
  return result;
}

/** Exactly one terminal row, preserving freshness ahead of status at narrow widths. */
export function compactPrSegments(
  number: number,
  presentation: PrPresentation,
  width: number,
  expanded = false,
): PrTextSegment[] {
  const numberText = number > 0 ? `#${number}` : "#?";
  const prefix: PrTextSegment[] = [
    { text: `     ${expanded ? "▾" : "▸"} `, kind: "plain" },
    { text: numberText, kind: "number" },
  ];
  const status: PrTextSegment[] = [
    { text: "  ", kind: "plain" },
    { text: presentation.primary, kind: "status" },
  ];
  const stale: PrTextSegment[] = presentation.stale
    ? [{ text: " · stale", kind: "stale" }]
    : [];
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
  const checks: PrTextSegment[] = icon
    ? [{ text: ` · checks ${icon}`, kind: "checks" }]
    : [];
  const full = [...prefix, ...status, ...checks, ...stale];
  if (displayWidth(full.map((segment) => segment.text).join("")) <= width)
    return full;
  const withoutChecks = [...prefix, ...status, ...stale];
  if (
    displayWidth(withoutChecks.map((segment) => segment.text).join("")) <= width
  )
    return withoutChecks;
  if (presentation.stale) {
    const short = `${numberText} stale`;
    const indent = " ".repeat(Math.max(0, width - displayWidth(short)));
    return truncateSegments(
      [
        { text: indent, kind: "plain" },
        { text: numberText, kind: "number" },
        { text: " stale", kind: "stale" },
      ],
      width,
    );
  }
  return truncateSegments([...prefix, ...status], width);
}

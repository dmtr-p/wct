import { Effect } from "effect";
import { execProcess } from "./process";
import { parseRemoteOwnerRepo } from "./github-service";
import { checkOutcome, type PrFacts } from "./pr-model";
import type { ExplicitPrAssociation, WorkspacePrEntry } from "./pr-cache-service";

export interface PushDestination { repository: string; branch: string }

function gitValue(cwd: string, args: string[]) {
  return Effect.catch(execProcess("git", args, { cwd }).pipe(Effect.map((result) => result.stdout.trim())), () => Effect.succeed(""));
}

/** Conservative prediction for the branch/ref written by a plain git push. */
export function predictPushRef(options: {
  branch: string;
  remote: string;
  upstreamRemote: string;
  upstreamMerge: string;
  pushDefault: string;
  refspecs: string[];
  pushRemoteRef: string;
}): string | null {
  const { branch, remote, upstreamRemote, upstreamMerge, pushDefault, refspecs, pushRemoteRef } = options;
  if (refspecs.length) {
    const source = `refs/heads/${branch}`;
    const matching = refspecs.filter((spec) => {
      const [from] = spec.replace(/^\+/, "").split(":");
      if (from === branch || from === source) return true;
      if (!from?.includes("*")) return false;
      const [prefix, suffix] = from.split("*");
      return source.startsWith(prefix ?? "") && source.endsWith(suffix ?? "");
    });
    return matching.length === 1 && pushRemoteRef.startsWith("refs/heads/")
      ? pushRemoteRef.slice("refs/heads/".length)
      : null;
  }
  if (pushDefault === "current") return branch;
  if (pushDefault === "simple") {
    if (remote !== upstreamRemote) return branch;
    return upstreamMerge === `refs/heads/${branch}` ? branch : null;
  }
  if (pushDefault === "upstream") {
    return remote === upstreamRemote && upstreamMerge.startsWith("refs/heads/")
      ? upstreamMerge.slice("refs/heads/".length)
      : null;
  }
  return null;
}

export function resolvePushDestination(cwd: string, branch: string) {
  return Effect.gen(function* () {
    const ref = yield* gitValue(cwd, ["for-each-ref", "--format=%(push:remotename)%09%(push:remoteref)", `refs/heads/${branch}`]);
    const [remote = "", pushRemoteRef = ""] = ref.split("\t");
    if (!remote) return null;
    const [upstreamRemote, upstreamMerge, rawDefault, rawRefspecs, rawUrls] = yield* Effect.all([
      gitValue(cwd, ["config", "--get", `branch.${branch}.remote`]),
      gitValue(cwd, ["config", "--get", `branch.${branch}.merge`]),
      gitValue(cwd, ["config", "--get", "push.default"]),
      gitValue(cwd, ["config", "--get-all", `remote.${remote}.push`]),
      gitValue(cwd, ["remote", "get-url", "--push", "--all", remote]),
    ]);
    const destination = predictPushRef({ branch, remote, upstreamRemote: upstreamRemote || "origin", upstreamMerge, pushDefault: rawDefault || "simple", refspecs: rawRefspecs ? rawRefspecs.split("\n") : [], pushRemoteRef });
    if (!destination || !rawUrls) return null;
    const repositories = rawUrls.split("\n").map(parseRemoteOwnerRepo);
    if (repositories.some((repo) => repo === null)) return null;
    const names = repositories.map((repo) => `${repo?.owner}/${repo?.repo}`);
    if (new Set(names.map((name) => name.toLowerCase())).size !== 1) return null;
    return { repository: names[0] ?? "", branch: destination } satisfies PushDestination;
  });
}

export function normalizeGhPr(raw: unknown, baseRepository: string, fetchedAt: number): PrFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.number !== "number" || typeof p.title !== "string" || typeof p.headRefName !== "string") return null;
  if (p.state !== "OPEN" && p.state !== "CLOSED" && p.state !== "MERGED") return null;
  const owner = p.headRepositoryOwner as { login?: string } | null;
  const repository = p.headRepository as { name?: string; nameWithOwner?: string } | null;
  const headRepository = typeof repository?.nameWithOwner === "string" ? repository.nameWithOwner : owner?.login && repository?.name ? `${owner.login}/${repository.name}` : null;
  const checks = Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup.map((check: unknown) => {
    const c = check && typeof check === "object" ? check as Record<string, unknown> : {};
    return { name: typeof c.name === "string" ? c.name : typeof c.context === "string" ? c.context : "unknown", outcome: checkOutcome(check), required: null };
  }) : null;
  return {
    baseRepository, number: p.number, id: typeof p.id === "string" ? p.id : "",
    url: typeof p.url === "string" ? p.url : "", title: p.title, state: p.state,
    isDraft: typeof p.isDraft === "boolean" ? p.isDraft : null, headRepository,
    headRefName: p.headRefName, headOid: typeof p.headRefOid === "string" ? p.headRefOid : null,
    baseRefName: typeof p.baseRefName === "string" ? p.baseRefName : null,
    reviewDecision: p.reviewDecision === "APPROVED" || p.reviewDecision === "CHANGES_REQUESTED" || p.reviewDecision === "REVIEW_REQUIRED" ? p.reviewDecision : null,
    mergeable: p.mergeable === "MERGEABLE" || p.mergeable === "CONFLICTING" || p.mergeable === "UNKNOWN" ? p.mergeable : null,
    mergeStateStatus: typeof p.mergeStateStatus === "string" ? p.mergeStateStatus : null,
    isMergeQueueEnabled: null, isQueued: null, updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
    checks, checksComplete: false, fetchedAt, lastError: null,
  };
}

/** The explicit choice wins; otherwise uncertain heads never auto-bind. */
export function resolveWorkspacePr(pool: readonly PrFacts[], branch: string, destination: PushDestination | null, explicit: ExplicitPrAssociation | null, fetchedAt: number): WorkspacePrEntry {
  const sameBranch = pool.filter((pr) => pr.headRefName === branch);
  const matching = destination
    ? pool.filter((pr) => pr.headRefName === destination.branch && pr.headRepository?.toLowerCase() === destination.repository.toLowerCase())
    : sameBranch;
  const sorted = [...matching].sort((a, b) => {
    const open = Number(b.state === "OPEN") - Number(a.state === "OPEN");
    return open || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
  const selected = explicit ? pool.find((pr) => pr.baseRepository.toLowerCase() === explicit.baseRepository.toLowerCase() && pr.number === explicit.number) ?? null : null;
  const newerOpenPr = selected?.state !== "OPEN" ? sorted.find((pr) => pr.state === "OPEN" && pr.number !== selected?.number)?.number ?? null : null;
  if (explicit) return { pr: selected, candidates: sorted, newerOpenPr, uncertain: selected === null, explicit: true, fetchedAt, lastError: null };
  if (!destination || sorted.filter((pr) => pr.state === "OPEN").length > 1) return { pr: null, candidates: sorted, newerOpenPr: null, uncertain: true, explicit: false, fetchedAt, lastError: null };
  return { pr: sorted[0] ?? null, candidates: sorted, newerOpenPr: null, uncertain: false, explicit: false, fetchedAt, lastError: null };
}

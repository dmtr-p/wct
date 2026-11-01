import { Clock, Effect } from "effect";
import { commandError } from "../errors";
import { graphQlAliasError, queryGitHub } from "./github-graphql";
import {
  checkOutcome,
  normalizeMergeable,
  normalizeReviewDecision,
  type PrCheck,
  type PrFacts,
} from "./pr-model";

const INITIAL_BATCH = 20;
const MAX_FOLLOW_UPS = 20;

interface ContextPage {
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  nodes: unknown[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contextPage(value: unknown): ContextPage | null {
  const page = record(value);
  const info = record(page?.pageInfo);
  if (!Array.isArray(page?.nodes) || typeof info?.hasNextPage !== "boolean")
    return null;
  if (
    info.hasNextPage &&
    (typeof info.endCursor !== "string" || !info.endCursor.trim())
  )
    return null;
  if (
    info.endCursor !== undefined &&
    info.endCursor !== null &&
    typeof info.endCursor !== "string"
  )
    return null;
  return {
    nodes: page.nodes,
    pageInfo: { hasNextPage: info.hasNextPage, endCursor: info.endCursor },
  };
}

function parseChecks(page: ContextPage): PrCheck[] {
  return page.nodes.map((node) => {
    const c =
      node && typeof node === "object" ? (node as Record<string, unknown>) : {};
    return {
      name:
        typeof c.name === "string"
          ? c.name
          : typeof c.context === "string"
            ? c.context
            : "unknown",
      outcome: checkOutcome(node),
      required: typeof c.isRequired === "boolean" ? c.isRequired : null,
    };
  });
}

function prFragment(number: number, cursor?: string): string {
  const after = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
  return `id number baseRepository { nameWithOwner } headRefOid mergeable mergeStateStatus reviewDecision isMergeQueueEnabled mergeQueueEntry { id } commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100${after}) { pageInfo { hasNextPage endCursor } nodes { __typename ... on CheckRun { name status conclusion isRequired(pullRequestNumber: ${number}) } ... on StatusContext { context state isRequired(pullRequestNumber: ${number}) } } } } } } }`;
}

function unwrapPage(raw: unknown) {
  const pr = record(raw);
  const commits = record(pr?.commits);
  const nodes = commits?.nodes;
  const commit =
    Array.isArray(nodes) && nodes.length === 1
      ? record(record(nodes[0])?.commit)
      : null;
  const rollup = record(commit?.statusCheckRollup);
  return {
    page:
      commit?.statusCheckRollup === null
        ? ({
            nodes: [],
            pageInfo: { hasNextPage: false },
          } satisfies ContextPage)
        : contextPage(rollup?.contexts),
    id: typeof pr?.id === "string" ? pr.id : "",
    number: pr?.number,
    baseRepository: record(pr?.baseRepository)?.nameWithOwner,
    headOid: pr?.headRefOid,
    checkedOid: commit?.oid,
    mergeable: normalizeMergeable(pr?.mergeable),
    mergeStateStatus:
      typeof pr?.mergeStateStatus === "string" ? pr.mergeStateStatus : null,
    reviewDecision: normalizeReviewDecision(pr?.reviewDecision),
    queued:
      pr?.mergeQueueEntry === null
        ? false
        : record(pr?.mergeQueueEntry)
          ? true
          : null,
    queueEnabled:
      typeof pr?.isMergeQueueEnabled === "boolean"
        ? pr.isMergeQueueEnabled
        : null,
  };
}

function identityError(
  detail: ReturnType<typeof unwrapPage>,
  pr: PrFacts,
  expectedId = pr.id,
): string | null {
  if (
    detail.number !== pr.number ||
    typeof detail.baseRepository !== "string" ||
    detail.baseRepository.toLowerCase() !== pr.baseRepository.toLowerCase() ||
    !detail.id ||
    (expectedId && detail.id !== expectedId)
  )
    return "PR detail identity mismatch";
  if (
    !pr.headOid ||
    detail.headOid !== pr.headOid ||
    detail.checkedOid !== pr.headOid
  )
    return "PR check head changed or is unavailable; refresh required";
  return null;
}

/** Batch detail fetches; a failed or capped connection never looks complete. */
export function fetchPrDetails(
  cwd: string,
  baseRepository: string,
  prs: readonly PrFacts[],
) {
  return Effect.gen(function* () {
    const [owner, repo] = baseRepository.split("/");
    if (!owner || !repo)
      return prs.map((pr) => ({
        ...pr,
        checksComplete: false,
        lastError: "Invalid base repository",
      }));
    const deadline = (yield* Clock.currentTimeMillis) + 10 * 60_000;
    const read = (query: string) =>
      Effect.gen(function* () {
        const remaining = deadline - (yield* Clock.currentTimeMillis);
        if (remaining <= 0)
          return yield* commandError(
            "pr_error",
            "PR detail work deadline exceeded",
          );
        return yield* queryGitHub(cwd, query).pipe(Effect.timeout(remaining));
      });
    const result: PrFacts[] = [];
    let followUps = 0;
    for (let start = 0; start < prs.length; start += INITIAL_BATCH) {
      const batch = prs.slice(start, start + INITIAL_BATCH);
      const aliases = batch
        .map(
          (pr, index) =>
            `p${index}: pullRequest(number: ${pr.number}) { ${prFragment(pr.number)} }`,
        )
        .join(" ");
      const query = `query { rateLimit { cost remaining } repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${aliases} } }`;
      const initial = yield* Effect.catch(read(query), (error) =>
        Effect.succeed({
          repository: null as Record<string, unknown> | null,
          error: error.message,
          errors: [],
          transportError: null,
        }),
      );
      for (let index = 0; index < batch.length; index++) {
        const pr = batch[index];
        if (!pr) continue;
        const failed =
          (initial as { error?: string }).error ??
          graphQlAliasError(initial, `p${index}`);
        if (!initial.repository || failed) {
          result.push({
            ...pr,
            checksComplete: false,
            lastError: failed ?? "PR detail fetch failed",
          });
          continue;
        }
        const first = unwrapPage(initial.repository[`p${index}`]);
        if (!first.page || !first.id || first.queueEnabled === null) {
          result.push({
            ...pr,
            checksComplete: false,
            lastError:
              initial.transportError ?? "Incomplete PR detail response",
          });
          continue;
        }
        const mismatch = identityError(first, pr);
        if (mismatch) {
          result.push({
            ...pr,
            checks: null,
            checksComplete: false,
            lastError: mismatch,
          });
          continue;
        }
        const checks = parseChecks(first.page);
        let cursor = first.page.pageInfo.endCursor;
        let hasNext = first.page.pageInfo.hasNextPage === true;
        let error: string | null = null;
        const cursors = new Set<string>();
        while (hasNext) {
          if (!cursor || cursors.has(cursor) || followUps >= MAX_FOLLOW_UPS) {
            error = "Check pagination limit reached";
            break;
          }
          cursors.add(cursor);
          followUps++;
          const nextQuery = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { p: pullRequest(number: ${pr.number}) { ${prFragment(pr.number, cursor)} } } }`;
          const next = yield* Effect.catch(read(nextQuery), (cause) =>
            Effect.succeed({
              repository: null as Record<string, unknown> | null,
              error: cause.message,
              errors: [],
              transportError: null,
            }),
          );
          const failedPage =
            (next as { error?: string }).error ?? graphQlAliasError(next, "p");
          if (!next.repository || failedPage) {
            error = failedPage ?? "Check page fetch failed";
            break;
          }
          const detail = unwrapPage(next.repository.p);
          const mismatch = identityError(detail, pr, first.id);
          if (mismatch) {
            error = mismatch;
            break;
          }
          const page = detail.page;
          if (!page) {
            error = "Incomplete check page";
            break;
          }
          checks.push(...parseChecks(page));
          hasNext = page.pageInfo.hasNextPage === true;
          cursor = page.pageInfo.endCursor;
        }
        result.push({
          ...pr,
          id: first.id,
          mergeable: first.mergeable,
          mergeStateStatus: first.mergeStateStatus,
          reviewDecision: first.reviewDecision,
          isMergeQueueEnabled: first.queueEnabled,
          isQueued: first.queued,
          checks: error ? null : checks,
          checksComplete: error === null,
          lastError: error,
        });
      }
    }
    return result;
  });
}

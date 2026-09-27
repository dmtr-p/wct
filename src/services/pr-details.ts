import { Effect } from "effect";
import { checkOutcome, type PrCheck, type PrFacts } from "./pr-model";
import { execProcess } from "./process";

const INITIAL_BATCH = 20;
const MAX_FOLLOW_UPS = 20;

interface ContextPage {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: unknown[];
}

function parseChecks(page: ContextPage): PrCheck[] {
  return (page.nodes ?? []).map((node) => {
    const c = node && typeof node === "object" ? node as Record<string, unknown> : {};
    return {
      name: typeof c.name === "string" ? c.name : typeof c.context === "string" ? c.context : "unknown",
      outcome: checkOutcome(node),
      required: typeof c.isRequired === "boolean" ? c.isRequired : null,
    };
  });
}

function prFragment(number: number, cursor?: string): string {
  const after = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
  return `id isMergeQueueEnabled mergeQueueEntry { id } commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100${after}) { pageInfo { hasNextPage endCursor } nodes { __typename ... on CheckRun { name status conclusion isRequired(pullRequestNumber: ${number}) } ... on StatusContext { context state isRequired(pullRequestNumber: ${number}) } } } } } } }`;
}

function unwrapPage(raw: unknown): { page: ContextPage | null; id: string; queued: boolean | null; queueEnabled: boolean | null } {
  if (!raw || typeof raw !== "object") return { page: null, id: "", queued: null, queueEnabled: null };
  const pr = raw as Record<string, unknown>;
  const commit = ((pr.commits as { nodes?: { commit?: { statusCheckRollup?: { contexts?: ContextPage } } }[] } | undefined)?.nodes ?? [])[0]?.commit;
  return {
    page: commit?.statusCheckRollup?.contexts ?? (commit?.statusCheckRollup === null ? { nodes: [], pageInfo: { hasNextPage: false } } : null),
    id: typeof pr.id === "string" ? pr.id : "",
    queued: pr.mergeQueueEntry === null ? false : typeof pr.mergeQueueEntry === "object",
    queueEnabled: typeof pr.isMergeQueueEnabled === "boolean" ? pr.isMergeQueueEnabled : null,
  };
}

function graphQl(cwd: string, query: string) {
  return Effect.flatMap(execProcess("gh", ["api", "graphql", "-f", `query=${query}`], { cwd }), (result) =>
    Effect.try({ try: () => {
      const response = JSON.parse(result.stdout) as { data?: { repository?: Record<string, unknown>; rateLimit?: { cost?: number } }; errors?: { message?: string }[] };
      if (response.errors?.length || !response.data?.repository) throw new Error(response.errors?.map((e) => e.message).join("; ") || "Missing repository");
      return response.data;
    }, catch: (error) => new Error(`GitHub GraphQL: ${String(error)}`) }));
}

/** Batch detail fetches; a failed or capped connection never looks complete. */
export function fetchPrDetails(cwd: string, baseRepository: string, prs: readonly PrFacts[]) {
  return Effect.gen(function* () {
    const [owner, repo] = baseRepository.split("/");
    if (!owner || !repo) return prs.map((pr) => ({ ...pr, checksComplete: false, lastError: "Invalid base repository" }));
    const result: PrFacts[] = [];
    let followUps = 0;
    for (let start = 0; start < prs.length; start += INITIAL_BATCH) {
      const batch = prs.slice(start, start + INITIAL_BATCH);
      const aliases = batch.map((pr, index) => `p${index}: pullRequest(number: ${pr.number}) { ${prFragment(pr.number)} }`).join(" ");
      const query = `query { rateLimit { cost remaining } repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${aliases} } }`;
      const initial = yield* Effect.catch(graphQl(cwd, query), (error) => Effect.succeed({ repository: null as Record<string, unknown> | null, error: String(error) }));
      for (let index = 0; index < batch.length; index++) {
        const pr = batch[index];
        if (!pr) continue;
        const failed = (initial as { error?: string }).error;
        if (!initial.repository) {
          result.push({ ...pr, checksComplete: false, lastError: failed ?? "PR detail fetch failed" });
          continue;
        }
        const first = unwrapPage(initial.repository[`p${index}`]);
        if (!first.page || !first.id || first.queueEnabled === null) {
          result.push({ ...pr, checksComplete: false, lastError: "Incomplete PR detail response" });
          continue;
        }
        const checks = parseChecks(first.page);
        let cursor = first.page.pageInfo?.endCursor;
        let hasNext = first.page.pageInfo?.hasNextPage === true;
        let error: string | null = null;
        while (hasNext) {
          if (!cursor || followUps >= MAX_FOLLOW_UPS) { error = "Check pagination limit reached"; break; }
          followUps++;
          const nextQuery = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { p: pullRequest(number: ${pr.number}) { ${prFragment(pr.number, cursor)} } } }`;
          const next = yield* Effect.catch(graphQl(cwd, nextQuery), (cause) => Effect.succeed({ repository: null as Record<string, unknown> | null, error: String(cause) }));
          if (!next.repository) { error = (next as { error?: string }).error ?? "Check page fetch failed"; break; }
          const page = unwrapPage(next.repository.p).page;
          if (!page || !page.pageInfo) { error = "Incomplete check page"; break; }
          checks.push(...parseChecks(page));
          hasNext = page.pageInfo.hasNextPage === true;
          cursor = page.pageInfo.endCursor;
        }
        result.push({ ...pr, id: first.id, isMergeQueueEnabled: first.queueEnabled, isQueued: first.queued, checks: error ? null : checks, checksComplete: error === null, lastError: error });
      }
    }
    return result;
  });
}

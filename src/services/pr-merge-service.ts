import { Effect } from "effect";
import { fetchPrDetails } from "./pr-details";
import { normalizeGhPr } from "./pr-discovery";
import type { PrFacts } from "./pr-model";
import { execProcess } from "./process";

export type MergeMethod = "SQUASH" | "REBASE" | "MERGE";
export const MERGE_METHODS: Record<
  MergeMethod,
  { label: string; explanation: string }
> = {
  SQUASH: {
    label: "Squash and merge",
    explanation:
      "Combine the PR's changes into one commit on the target branch.",
  },
  REBASE: {
    label: "Rebase and merge",
    explanation:
      "Replay the PR's commits onto the target branch without a merge commit.",
  },
  MERGE: {
    label: "Create a merge commit",
    explanation:
      "Preserve the PR's commits and join the histories with a merge commit.",
  },
};

export interface MergeSnapshot {
  pr: PrFacts;
  queueRequired: boolean | null;
  methods: MergeMethod[] | null;
  configurationError: string | null;
}

export type MergeEligibility =
  | { route: "direct"; methods: MergeMethod[] }
  | { route: "queue" }
  | { route: "ineligible" }
  | { route: "unavailable"; reason: string };

interface MergeSettings {
  mergeCommitAllowed?: boolean;
  squashMergeAllowed?: boolean;
  rebaseMergeAllowed?: boolean;
  mergeQueue?: { id?: string } | null;
}

const TARGET_FIELDS =
  "id,number,title,state,url,isDraft,reviewDecision,mergeable,mergeStateStatus,headRefName,headRefOid,headRepository,headRepositoryOwner,baseRefName,statusCheckRollup,updatedAt";

function decodeJson(text: string): unknown {
  const response = JSON.parse(text) as { errors?: { message?: string }[] };
  if (response.errors?.length)
    throw new Error(response.errors.map((error) => error.message).join("; "));
  return response;
}

export function fetchMergeSnapshot(
  cwd: string,
  baseRepository: string,
  number: number,
) {
  return Effect.gen(function* () {
    const viewed = yield* execProcess(
      "gh",
      [
        "pr",
        "view",
        String(number),
        "--repo",
        baseRepository,
        "--json",
        TARGET_FIELDS,
      ],
      { cwd },
    );
    const raw: unknown = yield* Effect.try({
      try: () => decodeJson(viewed.stdout),
      catch: (error) =>
        new Error(`Unable to read PR #${number}: ${String(error)}`),
    });
    const normalized = normalizeGhPr(raw, baseRepository, Date.now());
    if (!normalized)
      return yield* Effect.fail(
        new Error(`PR #${number} is missing required fields`),
      );
    const [detailed] = yield* fetchPrDetails(cwd, baseRepository, [normalized]);
    if (!detailed)
      return yield* Effect.fail(
        new Error(`Unable to fetch PR #${number} details`),
      );
    if (!detailed.baseRefName)
      return {
        pr: detailed,
        queueRequired: null,
        methods: null,
        configurationError: "target branch unreadable",
      } satisfies MergeSnapshot;
    const [owner, repo] = baseRepository.split("/");
    if (!owner || !repo)
      return {
        pr: detailed,
        queueRequired: null,
        methods: null,
        configurationError: "base repository unreadable",
      } satisfies MergeSnapshot;
    const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed mergeQueue(branch: ${JSON.stringify(detailed.baseRefName)}) { id } } }`;
    const configuration = yield* Effect.catch(
      execProcess("gh", ["api", "graphql", "-f", `query=${query}`], {
        cwd,
      }).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () =>
              decodeJson(result.stdout) as {
                data?: {
                  repository?: MergeSettings;
                };
              },
            catch: (error) => new Error(String(error)),
          }),
        ),
      ),
      () => Effect.succeed(null),
    );
    const settings = configuration?.data?.repository;
    const path = `repos/${owner}/${repo}/rules/branches/${encodeURIComponent(detailed.baseRefName)}`;
    const rules = yield* Effect.catch(
      execProcess("gh", ["api", path, "--paginate", "--jq", ".[].type"], {
        cwd,
      }).pipe(
        Effect.map((result) =>
          result.stdout.trim().split("\n").filter(Boolean),
        ),
      ),
      () => Effect.succeed(null),
    );
    return {
      pr: detailed,
      ...resolveMergeConfiguration(
        detailed.isMergeQueueEnabled,
        settings,
        rules,
      ),
    } satisfies MergeSnapshot;
  });
}

export function resolveMergeConfiguration(
  queueEnabled: boolean | null,
  settings: MergeSettings | undefined,
  rules: string[] | null,
): Omit<MergeSnapshot, "pr"> {
  // Any positive read-access signal establishes the queue route. A queue
  // submission does not need direct-merge methods or the other two reads.
  if (
    queueEnabled === true ||
    settings?.mergeQueue != null ||
    rules?.includes("merge_queue")
  )
    return { queueRequired: true, methods: null, configurationError: null };
  if (
    !settings ||
    settings.mergeQueue === undefined ||
    rules === null ||
    queueEnabled === null
  )
    return {
      queueRequired: null,
      methods: null,
      configurationError: "queue settings unreadable",
    };
  if (
    typeof settings.mergeCommitAllowed !== "boolean" ||
    typeof settings.squashMergeAllowed !== "boolean" ||
    typeof settings.rebaseMergeAllowed !== "boolean"
  )
    return {
      queueRequired: false,
      methods: null,
      configurationError: "merge methods unreadable",
    };
  const methods: MergeMethod[] = [];
  if (settings.squashMergeAllowed) methods.push("SQUASH");
  if (settings.rebaseMergeAllowed) methods.push("REBASE");
  if (settings.mergeCommitAllowed) methods.push("MERGE");
  return { queueRequired: false, methods, configurationError: null };
}

export function mergeEligibility(snapshot: MergeSnapshot): MergeEligibility {
  if (snapshot.configurationError || snapshot.queueRequired === null)
    return {
      route: "unavailable",
      reason: snapshot.configurationError ?? "queue settings unreadable",
    };
  const pr = snapshot.pr;
  if (
    pr.lastError ||
    !pr.checksComplete ||
    pr.checks === null ||
    pr.state !== "OPEN" ||
    pr.isDraft !== false ||
    !pr.id ||
    !pr.headOid ||
    pr.mergeable !== "MERGEABLE" ||
    (pr.mergeStateStatus !== "CLEAN" && pr.mergeStateStatus !== "UNSTABLE") ||
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    pr.reviewDecision === "REVIEW_REQUIRED" ||
    pr.isQueued ||
    pr.checks?.some(
      (check) => check.required === true && check.outcome !== "passed",
    )
  )
    return { route: "ineligible" };
  if (snapshot.queueRequired) return { route: "queue" };
  if (!snapshot.methods?.length)
    return { route: "unavailable", reason: "merge methods unavailable" };
  return { route: "direct", methods: snapshot.methods };
}

/** Includes all facts that can change eligibility or route without changing the head SHA. */
export function mergeSnapshotFingerprint(snapshot: MergeSnapshot): string {
  const p = snapshot.pr;
  return JSON.stringify({
    baseRepository: p.baseRepository,
    number: p.number,
    id: p.id,
    state: p.state,
    draft: p.isDraft,
    headOid: p.headOid,
    baseRefName: p.baseRefName,
    reviewDecision: p.reviewDecision,
    mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus,
    queued: p.isQueued,
    checksComplete: p.checksComplete,
    checks: p.checks
      ?.map((check) => [check.name, check.required, check.outcome])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    queueRequired: snapshot.queueRequired,
    methods: snapshot.methods?.slice().sort(),
  });
}

export function validateSubmission(
  confirmed: MergeSnapshot,
  current: MergeSnapshot,
  method?: MergeMethod,
): "direct" | "queue" {
  if (mergeSnapshotFingerprint(current) !== mergeSnapshotFingerprint(confirmed))
    throw new Error(
      "PR eligibility or routing changed; refresh and confirm again",
    );
  const eligible = mergeEligibility(current);
  if (eligible.route !== (confirmed.queueRequired ? "queue" : "direct"))
    throw new Error("PR is no longer eligible; refresh and confirm again");
  if (
    eligible.route === "direct" &&
    (!method || !eligible.methods.includes(method))
  )
    throw new Error("Selected merge method is no longer available");
  return eligible.route;
}

export function buildPrMutation(
  pr: PrFacts,
  route: "direct" | "queue",
  method?: MergeMethod,
): string {
  if (!pr.id || !pr.headOid)
    throw new Error("PR identity or head SHA is missing");
  const input = `pullRequestId: ${JSON.stringify(pr.id)}, expectedHeadOid: ${JSON.stringify(pr.headOid)}`;
  if (route === "queue")
    return `mutation { enqueuePullRequest(input: { ${input} }) { mergeQueueEntry { id state } } }`;
  if (!method || !MERGE_METHODS[method])
    throw new Error("Select an enabled merge method");
  return `mutation { mergePullRequest(input: { ${input}, mergeMethod: ${method} }) { pullRequest { merged state } } }`;
}

export function submitPrMerge(
  cwd: string,
  confirmed: MergeSnapshot,
  method?: MergeMethod,
) {
  return Effect.gen(function* () {
    const current = yield* fetchMergeSnapshot(
      cwd,
      confirmed.pr.baseRepository,
      confirmed.pr.number,
    );
    const route = yield* Effect.try({
      try: () => validateSubmission(confirmed, current, method),
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    });
    const pr = current.pr;
    const query = buildPrMutation(pr, route, method);
    const response = yield* execProcess(
      "gh",
      ["api", "graphql", "-f", `query=${query}`],
      { cwd },
    );
    const data = yield* Effect.try({
      try: () =>
        decodeJson(response.stdout) as {
          data?: {
            enqueuePullRequest?: { mergeQueueEntry?: { id?: string } };
            mergePullRequest?: { pullRequest?: { merged?: boolean } };
          };
        },
      catch: (error) => new Error(String(error)),
    });
    if (route === "queue" && data.data?.enqueuePullRequest?.mergeQueueEntry?.id)
      return "queued" as const;
    if (
      route === "direct" &&
      data.data?.mergePullRequest?.pullRequest?.merged === true
    )
      return "merged" as const;
    return yield* Effect.fail(
      new Error("GitHub did not report a merged or queued result"),
    );
  });
}

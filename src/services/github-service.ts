import type { BunServices } from "@effect/platform-bun";
import { Clock, Context, Effect } from "effect";
import {
  captureBunService,
  type ServiceImplementation,
} from "../effect/service-context";
import { commandError, toWctError, type WctError } from "../errors";
import { graphQlAliasError, queryGitHub } from "./github-graphql";
import { execProcess, getProcessErrorMessage, runProcess } from "./process";

const GITHUB_PR_URL_PATTERN =
  /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/;

export interface PrInfo {
  branch: string;
  prNumber: number;
  isCrossRepository: boolean;
  headOwner?: string;
  headRepo?: string;
}

export interface RawPrResult {
  number: number;
  raw: unknown;
  error: string | null;
}

export interface GitHubService {
  isGhInstalled: Effect.Effect<boolean, WctError>;
  resolvePr: (
    prNumber: number,
    cwd?: string,
  ) => Effect.Effect<PrInfo, WctError>;
  addForkRemote: (
    remoteName: string,
    owner: string,
    repo: string,
    cwd?: string,
  ) => Effect.Effect<void, WctError>;
  fetchBranch: (
    branch: string,
    remote?: string,
    cwd?: string,
  ) => Effect.Effect<void, WctError>;
  resolveBaseRepo: (cwd: string) => Effect.Effect<string, WctError>;
  listRawPrs: (
    cwd: string,
    state: "all" | "updated",
    baseRepository: string,
    updatedSince?: number,
  ) => Effect.Effect<unknown[], WctError>;
  getRawPrs: (
    cwd: string,
    baseRepository: string,
    numbers: readonly number[],
  ) => Effect.Effect<RawPrResult[], WctError>;
  findRemoteForRepo: (
    owner: string,
    repo: string,
    cwd?: string,
  ) => Effect.Effect<string | null, WctError>;
}

export const GitHubService =
  Context.Service<GitHubService>("wct/GitHubService");

function extractShellError(error: unknown): string {
  return getProcessErrorMessage(error);
}

export function parsePrArg(value: string): number | null {
  const asNumber = Number(value);
  if (Number.isInteger(asNumber) && asNumber > 0) {
    return asNumber;
  }

  const match = value.match(GITHUB_PR_URL_PATTERN);
  if (match) {
    return Number(match[1]);
  }

  return null;
}

const GITHUB_REMOTE_PATTERN =
  /(?:^git@github\.com:|\/\/(?:[^@]+@)?github\.com(?::\d+)?[:/])([^/]+)\/([^/\s]+?)(?:\.git)?$/;

export function parseRemoteOwnerRepo(
  url: string,
): { owner: string; repo: string } | null {
  const match = url.match(GITHUB_REMOTE_PATTERN);
  if (match?.[1] && match[2]) return { owner: match[1], repo: match[2] };
  return null;
}

export function findMatchingRemote(
  remoteOutput: string,
  owner: string,
  repo: string,
): string | null {
  const lowerOwner = owner.toLowerCase();
  const lowerRepo = repo.toLowerCase();
  let bestMatch: string | null = null;

  for (const line of remoteOutput.split("\n")) {
    const parts = line.split(/\s+/);
    const [name, url, fetchTag] = parts;
    if (name && url && fetchTag === "(fetch)") {
      const parsed = parseRemoteOwnerRepo(url);
      if (
        parsed &&
        parsed.owner.toLowerCase() === lowerOwner &&
        parsed.repo.toLowerCase() === lowerRepo
      ) {
        if (name === "origin") return "origin";
        if (name === "upstream" && bestMatch !== "origin") bestMatch = name;
        bestMatch ??= name;
      }
    }
  }
  return bestMatch;
}

function detectRemoteUrl(owner: string, repo: string, cwd?: string) {
  return Effect.gen(function* () {
    const originUrl = yield* Effect.orElseSucceed(
      execProcess(
        "git",
        ["remote", "get-url", "origin"],
        cwd ? { cwd } : undefined,
      ).pipe(Effect.map((result) => result.stdout.trim())),
      () => null,
    );

    if (
      originUrl &&
      (originUrl.startsWith("git@") || originUrl.includes("ssh://"))
    ) {
      return `git@github.com:${owner}/${repo}.git`;
    }

    return `https://github.com/${owner}/${repo}.git`;
  });
}

export const GITHUB_PR_JSON_FIELDS =
  "id,number,title,state,url,isDraft,reviewDecision,mergeable,mergeStateStatus,headRefName,headRefOid,headRepository,headRepositoryOwner,baseRefName,statusCheckRollup,updatedAt";

const DISCOVERY_GRAPHQL_FIELDS =
  "id number title state url isDraft reviewDecision mergeable mergeStateStatus headRefName headRefOid headRepository { nameWithOwner name } headRepositoryOwner { login } baseRefName updatedAt";

export function parseAllPrPages(stdout: string): unknown[] {
  const pages: unknown = JSON.parse(stdout);
  if (!Array.isArray(pages) || pages.length === 0)
    throw new Error("Missing PR pages");
  const prs: unknown[] = [];
  for (const page of pages) {
    const response = page as {
      errors?: { message?: string }[];
      data?: {
        repository?: {
          pullRequests?: {
            nodes?: unknown[];
            pageInfo?: { hasNextPage?: boolean };
          };
        };
      };
    };
    if (response?.errors?.length)
      throw new Error(response.errors.map((error) => error.message).join("; "));
    const connection = response?.data?.repository?.pullRequests;
    if (!Array.isArray(connection?.nodes) || !connection.pageInfo)
      throw new Error("Incomplete PR page");
    prs.push(...connection.nodes);
  }
  const last = pages.at(-1) as {
    data?: {
      repository?: { pullRequests?: { pageInfo?: { hasNextPage?: boolean } } };
    };
  };
  if (last.data?.repository?.pullRequests?.pageInfo?.hasNextPage !== false)
    throw new Error("PR pagination did not finish");
  return prs;
}

function listRawPrsImpl(
  cwd: string,
  state: "all" | "updated",
  baseRepository: string,
  updatedSince?: number,
) {
  const [owner, repo] = baseRepository.split("/");
  if (!owner || !repo)
    return Effect.fail(commandError("pr_error", "Invalid base repository"));
  const query = `query($endCursor: String) { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { pullRequests(first: 100, after: $endCursor, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${DISCOVERY_GRAPHQL_FIELDS} } pageInfo { hasNextPage endCursor } } } }`;
  if (state === "all")
    return Effect.flatMap(
      execProcess(
        "gh",
        ["api", "graphql", "--paginate", "--slurp", "-f", `query=${query}`],
        { cwd },
      ).pipe(Effect.timeout("10 minutes")),
      (result) =>
        Effect.try({
          try: () => parseAllPrPages(result.stdout),
          catch: (error) => commandError("pr_error", String(error), error),
        }),
    );
  if (updatedSince === undefined || !Number.isFinite(updatedSince))
    return Effect.fail(
      commandError("pr_error", "Missing PR discovery checkpoint"),
    );
  return Effect.gen(function* () {
    const result: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const response = yield* queryGitHub(
        cwd,
        query,
        cursor ? { endCursor: cursor } : {},
      );
      const failed = graphQlAliasError(response, "pullRequests");
      if (failed) return yield* commandError("pr_error", failed);
      const connection = response.repository.pullRequests as
        | {
            nodes?: unknown[];
            pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          }
        | undefined;
      if (
        !Array.isArray(connection?.nodes) ||
        typeof connection.pageInfo?.hasNextPage !== "boolean"
      )
        return yield* commandError(
          "pr_error",
          response.transportError ?? "Incomplete updated PR page",
        );
      let reachedCheckpoint = false;
      for (const value of connection.nodes) {
        const updatedAt =
          value && typeof value === "object"
            ? (value as { updatedAt?: string }).updatedAt
            : undefined;
        const updated =
          typeof updatedAt === "string" ? Date.parse(updatedAt) : NaN;
        if (!Number.isFinite(updated))
          return yield* commandError("pr_error", "Missing PR update timestamp");
        if (updated < updatedSince) reachedCheckpoint = true;
        else result.push(value);
      }
      if (reachedCheckpoint || !connection.pageInfo.hasNextPage) return result;
      cursor = connection.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor))
        return yield* commandError(
          "pr_error",
          "Incomplete updated PR pagination",
        );
      cursors.add(cursor);
    }
  }).pipe(Effect.timeout("10 minutes"));
}

function getRawPrsImpl(
  cwd: string,
  baseRepository: string,
  numbers: readonly number[],
) {
  return Effect.gen(function* () {
    const [owner, repo] = baseRepository.split("/");
    if (
      !owner ||
      !repo ||
      numbers.some((number) => !Number.isSafeInteger(number) || number < 1)
    )
      return yield* commandError("pr_error", "Invalid PR identities");
    const deadline = (yield* Clock.currentTimeMillis) + 10 * 60_000;
    const result: RawPrResult[] = [];
    for (let start = 0; start < numbers.length; start += 20) {
      const batch = numbers.slice(start, start + 20);
      const aliases = batch
        .map(
          (number, index) =>
            `p${index}: pullRequest(number: ${number}) { ${DISCOVERY_GRAPHQL_FIELDS} baseRepository { nameWithOwner } }`,
        )
        .join(" ");
      const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${aliases} } }`;
      const fetched = yield* Effect.gen(function* () {
        const batchResult: RawPrResult[] = [];
        const remaining = deadline - (yield* Clock.currentTimeMillis);
        if (remaining <= 0)
          return yield* commandError(
            "pr_error",
            "PR batch work deadline exceeded",
          );
        const parsed = yield* queryGitHub(cwd, query).pipe(
          Effect.timeout(remaining),
        );
        for (const [index, number] of batch.entries()) {
          const alias = `p${index}`;
          const failure = graphQlAliasError(parsed, alias);
          const raw = parsed.repository[alias] as
            | { number?: number; baseRepository?: { nameWithOwner?: string } }
            | null
            | undefined;
          const error =
            failure ??
            (raw?.number !== number ||
            raw.baseRepository?.nameWithOwner?.toLowerCase() !==
              baseRepository.toLowerCase()
              ? (parsed.transportError ?? "Incomplete PR batch response")
              : null);
          batchResult.push({ number, raw, error });
        }
        return batchResult;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            batch.map((number) => ({
              number,
              raw: null,
              error: extractShellError(error),
            })),
          ),
        ),
      );
      result.push(...fetched);
    }
    return result;
  });
}

export type GitHubServiceImplementation = ServiceImplementation<
  GitHubService,
  BunServices.BunServices
>;

export const liveGitHubService: GitHubServiceImplementation = {
  isGhInstalled: runProcess("gh", ["--version"]).pipe(
    Effect.timeout("2 minutes"),
    Effect.mapError((error) =>
      commandError("pr_error", extractShellError(error), error),
    ),
    Effect.map((r) => r.success),
  ),
  resolvePr: (prNumber, cwd) =>
    Effect.mapError(
      Effect.gen(function* () {
        const result = yield* execProcess(
          "gh",
          [
            "pr",
            "view",
            String(prNumber),
            "--json",
            "headRefName,isCrossRepository,headRepositoryOwner,headRepository",
          ],
          cwd ? { cwd } : undefined,
        ).pipe(Effect.timeout("2 minutes"));
        const data = yield* Effect.try({
          try: () => JSON.parse(result.stdout.trim()),
          catch: () =>
            commandError(
              "pr_error",
              `Failed to parse PR #${prNumber} response`,
            ),
        });

        const pr: PrInfo = {
          branch: data.headRefName,
          prNumber,
          isCrossRepository: data.isCrossRepository ?? false,
        };

        pr.headOwner = data.headRepositoryOwner?.login;
        pr.headRepo = data.headRepository?.name;

        if (!pr.branch) {
          return yield* commandError(
            "pr_error",
            `PR #${prNumber} has no head branch`,
          );
        }

        return pr;
      }),
      (error) =>
        error instanceof Error && "code" in error
          ? toWctError(error)
          : commandError(
              "pr_error",
              `Failed to resolve PR #${prNumber}: ${extractShellError(error)}`,
              error,
            ),
    ),
  addForkRemote: (remoteName, owner, repo, cwd) =>
    Effect.gen(function* () {
      const url = yield* detectRemoteUrl(owner, repo, cwd);

      const existingRemote = yield* Effect.orElseSucceed(
        execProcess(
          "git",
          ["remote", "get-url", remoteName],
          cwd ? { cwd } : undefined,
        ).pipe(Effect.map((result) => result.stdout.trim())),
        () => null,
      );

      if (existingRemote !== null) {
        const sshUrl = `git@github.com:${owner}/${repo}.git`;
        const httpsUrl = `https://github.com/${owner}/${repo}.git`;
        if (existingRemote === sshUrl || existingRemote === httpsUrl) {
          return;
        }

        return yield* commandError(
          "pr_error",
          `Failed to add remote '${remoteName}': Remote '${remoteName}' already exists with URL '${existingRemote}' (expected ${url})`,
        );
      }

      yield* Effect.mapError(
        execProcess(
          "git",
          ["remote", "add", remoteName, url],
          cwd ? { cwd } : undefined,
        ),
        (error) =>
          error instanceof Error && "code" in error
            ? toWctError(error)
            : commandError(
                "pr_error",
                `Failed to add remote '${remoteName}': ${extractShellError(error)}`,
                error,
              ),
      );
    }),
  fetchBranch: (branch, remote = "origin", cwd) =>
    Effect.mapError(
      execProcess(
        "git",
        ["fetch", remote, `${branch}:refs/remotes/${remote}/${branch}`],
        cwd ? { cwd } : undefined,
      ).pipe(Effect.asVoid),
      (error) =>
        commandError(
          "pr_error",
          `Failed to fetch branch '${branch}': ${extractShellError(error)}`,
          error,
        ),
    ),
  resolveBaseRepo: (cwd) =>
    Effect.mapError(
      execProcess("gh", ["repo", "view", "--json", "nameWithOwner"], {
        cwd,
      }).pipe(
        Effect.timeout("2 minutes"),
        Effect.flatMap((result) =>
          Effect.try({
            try: () => {
              const name = (
                JSON.parse(result.stdout) as { nameWithOwner?: unknown }
              ).nameWithOwner;
              if (typeof name !== "string" || !/^[^/]+\/[^/]+$/.test(name))
                throw new Error("Invalid repository identity");
              return name;
            },
            catch: (error) =>
              commandError(
                "pr_error",
                "Unable to resolve base repository; run gh repo set-default in the main repository",
                error,
              ),
          }),
        ),
      ),
      (error) =>
        commandError(
          "pr_error",
          `Unable to resolve base repository: ${extractShellError(error)}; run gh repo set-default in the main repository`,
          error,
        ),
    ),
  listRawPrs: (cwd, state, baseRepository, updatedSince) =>
    Effect.mapError(
      listRawPrsImpl(cwd, state, baseRepository, updatedSince),
      (error) =>
        commandError(
          "pr_error",
          `Failed to list ${state} PRs: ${extractShellError(error)}`,
          error,
        ),
    ),
  getRawPrs: (cwd, baseRepository, numbers) =>
    getRawPrsImpl(cwd, baseRepository, numbers).pipe(
      Effect.mapError((error) =>
        commandError(
          "pr_error",
          `Failed to fetch PRs: ${extractShellError(error)}`,
          error,
        ),
      ),
    ),
  findRemoteForRepo: (owner, repo, cwd) =>
    Effect.gen(function* () {
      const result = yield* Effect.orElseSucceed(
        execProcess("git", ["remote", "-v"], cwd ? { cwd } : undefined),
        () => null,
      );
      if (!result) return null;
      return findMatchingRemote(result.stdout, owner, repo);
    }),
};

export function makeGitHubService(
  implementation: GitHubServiceImplementation = liveGitHubService,
) {
  return captureBunService<GitHubService>(implementation);
}

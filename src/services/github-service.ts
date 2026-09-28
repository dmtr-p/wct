import type { BunServices } from "@effect/platform-bun";
import { Context, Effect } from "effect";
import { commandError, toWctError, type WctError } from "../errors";
import { checkOutcome } from "./pr-model";
import {
  execProcess,
  getProcessErrorMessage,
  ProcessExitError,
  runProcess,
} from "./process";

const GITHUB_PR_URL_PATTERN =
  /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/;

export interface PrInfo {
  branch: string;
  prNumber: number;
  isCrossRepository: boolean;
  headOwner?: string;
  headRepo?: string;
}

export interface PrListItem {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  rollupState: "success" | "failure" | "pending" | "unknown" | null;
}

/**
 * Aggregates a `statusCheckRollup` array from `gh pr list --json` into a
 * single rollup state, matching the rules GitHub's web UI uses:
 *
 * - Any FAILURE / TIMED_OUT / STARTUP_FAILURE → "failure"
 * - Else any IN_PROGRESS / QUEUED / PENDING / ACTION_REQUIRED → "pending"
 * - Else any CANCELLED / unknown → "unknown"
 * - Else all SUCCESS / SKIPPED / NEUTRAL → "success"
 * - Empty array → null
 */
export function computeRollup(
  checks: unknown[],
): "success" | "failure" | "pending" | "unknown" | null {
  if (checks.length === 0) return null;

  let hasPending = false;
  let hasUnknown = false;

  for (const entry of checks) {
    const outcome = checkOutcome(entry);
    if (outcome === "failed") return "failure";
    if (outcome === "pending") hasPending = true;
    if (outcome === "unknown" || outcome === "cancelled") hasUnknown = true;
  }

  return hasPending ? "pending" : hasUnknown ? "unknown" : "success";
}

export function parseGhPrList(stdout: string): PrListItem[] {
  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) return [];
    const results: PrListItem[] = [];
    for (const pr of data) {
      if (
        typeof pr.number === "number" &&
        typeof pr.title === "string" &&
        (pr.state === "OPEN" ||
          pr.state === "MERGED" ||
          pr.state === "CLOSED") &&
        typeof pr.headRefName === "string"
      ) {
        let rollupState: PrListItem["rollupState"] = null;
        if (Array.isArray(pr.statusCheckRollup)) {
          rollupState = computeRollup(pr.statusCheckRollup);
        }
        results.push({
          number: pr.number,
          title: pr.title,
          state: pr.state as PrListItem["state"],
          headRefName: pr.headRefName,
          rollupState,
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export interface GitHubService {
  isGhInstalled: () => Effect.Effect<
    boolean,
    WctError,
    BunServices.BunServices
  >;
  resolvePr: (
    prNumber: number,
    cwd?: string,
  ) => Effect.Effect<PrInfo, WctError, BunServices.BunServices>;
  addForkRemote: (
    remoteName: string,
    owner: string,
    repo: string,
    cwd?: string,
  ) => Effect.Effect<void, WctError, BunServices.BunServices>;
  fetchBranch: (
    branch: string,
    remote?: string,
    cwd?: string,
  ) => Effect.Effect<void, WctError, BunServices.BunServices>;
  listPrs: (
    cwd: string,
  ) => Effect.Effect<PrListItem[], WctError, BunServices.BunServices>;
  resolveBaseRepo: (
    cwd: string,
  ) => Effect.Effect<string, WctError, BunServices.BunServices>;
  listRawPrs: (
    cwd: string,
    state: "open" | "all",
    baseRepository: string,
  ) => Effect.Effect<unknown[], WctError, BunServices.BunServices>;
  getRawPr: (
    cwd: string,
    baseRepository: string,
    number: number,
  ) => Effect.Effect<unknown, WctError, BunServices.BunServices>;
  findRemoteForRepo: (
    owner: string,
    repo: string,
    cwd?: string,
  ) => Effect.Effect<string | null, WctError, BunServices.BunServices>;
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
    const originUrl = yield* Effect.catch(
      execProcess(
        "git",
        ["remote", "get-url", "origin"],
        cwd ? { cwd } : undefined,
      ).pipe(Effect.map((result) => result.stdout.trim())),
      () => Effect.succeed(null),
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

/**
 * Returns true when the error represents "gh is not installed" — i.e. the
 * executable was not found on PATH.  We detect this via the ENOENT code that
 * Bun/Node sets on the underlying spawn error, surfaced through
 * `ProcessExitError.cause`.
 */
export function isGhNotInstalledError(error: unknown): boolean {
  if (!(error instanceof ProcessExitError)) return false;
  if (error.exitCode !== null) return false; // Non-zero exit — gh ran but failed
  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code: unknown }).code === "ENOENT"
  );
}

function listPrsImpl(cwd: string) {
  return Effect.catch(
    execProcess(
      "gh",
      [
        "pr",
        "list",
        "--json",
        "number,title,state,headRefName,statusCheckRollup",
        "--limit",
        "1000",
      ],
      { cwd },
    ).pipe(Effect.map((result) => parseGhPrList(result.stdout.trim()))),
    (error) =>
      isGhNotInstalledError(error)
        ? Effect.succeed([] as PrListItem[])
        : Effect.fail(error),
  );
}

const DISCOVERY_FIELDS =
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
  state: "open" | "all",
  baseRepository: string,
) {
  if (state === "all") {
    const [owner, repo] = baseRepository.split("/");
    if (!owner || !repo)
      return Effect.fail(commandError("pr_error", "Invalid base repository"));
    const query = `query($endCursor: String) { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { pullRequests(first: 100, after: $endCursor) { nodes { ${DISCOVERY_GRAPHQL_FIELDS} } pageInfo { hasNextPage endCursor } } } }`;
    return Effect.flatMap(
      execProcess(
        "gh",
        ["api", "graphql", "--paginate", "--slurp", "-f", `query=${query}`],
        { cwd },
      ).pipe(Effect.timeout("2 minutes")),
      (result) =>
        Effect.try({
          try: () => parseAllPrPages(result.stdout),
          catch: (error) => commandError("pr_error", String(error), error),
        }),
    );
  }
  return Effect.flatMap(
    execProcess(
      "gh",
      [
        "pr",
        "list",
        "--state",
        state,
        "--limit",
        "100000",
        "--json",
        DISCOVERY_FIELDS,
      ],
      { cwd },
    ),
    (result) =>
      Effect.try({
        try: () => {
          const value: unknown = JSON.parse(result.stdout);
          if (!Array.isArray(value)) throw new Error("Expected PR array");
          return value;
        },
        catch: (error) => commandError("pr_error", String(error), error),
      }),
  );
}

function getRawPrImpl(cwd: string, baseRepository: string, number: number) {
  const [owner, repo] = baseRepository.split("/");
  if (!owner || !repo || !Number.isSafeInteger(number) || number < 1)
    return Effect.fail(commandError("pr_error", "Invalid PR identity"));
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { pullRequest(number: ${number}) { ${DISCOVERY_GRAPHQL_FIELDS} baseRepository { nameWithOwner } } } }`;
  return Effect.flatMap(
    execProcess("gh", ["api", "graphql", "-f", `query=${query}`], { cwd }),
    (result) =>
      Effect.try({
        try: () => {
          const response = JSON.parse(result.stdout) as {
            errors?: { message?: string }[];
            data?: {
              repository?: {
                pullRequest?: {
                  number?: number;
                  baseRepository?: { nameWithOwner?: string };
                };
              };
            };
          };
          if (response.errors?.length)
            throw new Error(
              response.errors.map((error) => error.message).join("; "),
            );
          const pr = response.data?.repository?.pullRequest;
          if (
            pr?.number !== number ||
            pr.baseRepository?.nameWithOwner?.toLowerCase() !==
              baseRepository.toLowerCase()
          )
            throw new Error("Fetched PR identity does not match association");
          return pr;
        },
        catch: (error) => commandError("pr_error", String(error), error),
      }),
  );
}

export const liveGitHubService: GitHubService = GitHubService.of({
  isGhInstalled: () =>
    Effect.mapError(
      runProcess("gh", ["--version"]).pipe(Effect.map((r) => r.success)),
      (error) =>
        commandError("gh_not_installed", "Failed to run GitHub CLI", error),
    ),
  resolvePr: (prNumber, cwd) =>
    Effect.catch(
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
        );
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
          return yield* Effect.fail(
            commandError("pr_error", `PR #${prNumber} has no head branch`),
          );
        }

        return pr;
      }),
      (error) =>
        Effect.fail(
          error instanceof Error && "code" in error
            ? toWctError(error)
            : commandError(
                "pr_error",
                `Failed to resolve PR #${prNumber}: ${extractShellError(error)}`,
                error,
              ),
        ),
    ),
  addForkRemote: (remoteName, owner, repo, cwd) =>
    Effect.gen(function* () {
      const url = yield* detectRemoteUrl(owner, repo, cwd);

      const existingRemote = yield* Effect.catch(
        execProcess(
          "git",
          ["remote", "get-url", remoteName],
          cwd ? { cwd } : undefined,
        ).pipe(Effect.map((result) => result.stdout.trim())),
        () => Effect.succeed(null),
      );

      if (existingRemote !== null) {
        const sshUrl = `git@github.com:${owner}/${repo}.git`;
        const httpsUrl = `https://github.com/${owner}/${repo}.git`;
        if (existingRemote === sshUrl || existingRemote === httpsUrl) {
          return;
        }

        return yield* Effect.fail(
          commandError(
            "pr_error",
            `Failed to add remote '${remoteName}': Remote '${remoteName}' already exists with URL '${existingRemote}' (expected ${url})`,
          ),
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
  listPrs: (cwd) =>
    Effect.mapError(listPrsImpl(cwd), (error) =>
      commandError("pr_error", extractShellError(error), error),
    ),
  resolveBaseRepo: (cwd) =>
    Effect.mapError(
      execProcess("gh", ["repo", "view", "--json", "nameWithOwner"], {
        cwd,
      }).pipe(
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
          "Unable to resolve base repository; run gh repo set-default in the main repository",
          error,
        ),
    ),
  listRawPrs: (cwd, state, baseRepository) =>
    Effect.mapError(listRawPrsImpl(cwd, state, baseRepository), (error) =>
      commandError(
        "pr_error",
        `Failed to list ${state} PRs: ${extractShellError(error)}`,
        error,
      ),
    ),
  getRawPr: (cwd, baseRepository, number) =>
    Effect.mapError(getRawPrImpl(cwd, baseRepository, number), (error) =>
      commandError(
        "pr_error",
        `Failed to read PR #${number}: ${extractShellError(error)}`,
        error,
      ),
    ),
  findRemoteForRepo: (owner, repo, cwd) =>
    Effect.gen(function* () {
      const result = yield* Effect.catch(
        execProcess("git", ["remote", "-v"], cwd ? { cwd } : undefined),
        () => Effect.succeed(null),
      );
      if (!result) return null;
      return findMatchingRemote(result.stdout, owner, repo);
    }),
});

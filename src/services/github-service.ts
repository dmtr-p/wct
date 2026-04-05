import { Effect, ServiceMap } from "effect";
import type { WctRuntimeServices } from "../effect/services";
import { commandError, toWctError, type WctError } from "../errors";
import { execProcess, getProcessErrorMessage, runProcess } from "./process";

const GITHUB_PR_URL_PATTERN =
  /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/;

export interface PrInfo {
  branch: string;
  prNumber: number;
  isCrossRepository: boolean;
  forkOwner?: string;
  forkRepo?: string;
}

export interface PrListItem {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
}

export interface PrCheckInfo {
  name: string;
  state: string;
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
        results.push({
          number: pr.number,
          title: pr.title,
          state: pr.state as PrListItem["state"],
          headRefName: pr.headRefName,
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export function parseGhPrChecks(stdout: string): PrCheckInfo[] {
  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) return [];
    const results: PrCheckInfo[] = [];
    for (const c of data) {
      if (typeof c.name === "string" && typeof c.state === "string") {
        results.push({ name: c.name, state: c.state });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export interface GitHubService {
  isGhInstalled: () => Effect.Effect<boolean, WctError, WctRuntimeServices>;
  resolvePr: (
    prNumber: number,
    cwd?: string,
  ) => Effect.Effect<PrInfo, WctError, WctRuntimeServices>;
  addForkRemote: (
    remoteName: string,
    owner: string,
    repo: string,
    cwd?: string,
  ) => Effect.Effect<void, WctError, WctRuntimeServices>;
  fetchBranch: (
    branch: string,
    remote?: string,
    cwd?: string,
  ) => Effect.Effect<void, WctError, WctRuntimeServices>;
  listPrs: (
    cwd: string,
  ) => Effect.Effect<PrListItem[], WctError, WctRuntimeServices>;
  listPrChecks: (
    cwd: string,
    prNumber: number,
  ) => Effect.Effect<PrCheckInfo[], WctError, WctRuntimeServices>;
}

export const GitHubService =
  ServiceMap.Service<GitHubService>("wct/GitHubService");

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

function listPrsImpl(cwd: string) {
  return Effect.catch(
    execProcess(
      "gh",
      [
        "pr",
        "list",
        "--json",
        "number,title,state,headRefName",
        "--limit",
        "20",
      ],
      { cwd },
    ).pipe(Effect.map((result) => parseGhPrList(result.stdout.trim()))),
    () => Effect.succeed([] as PrListItem[]),
  );
}

function listPrChecksImpl(cwd: string, prNumber: number) {
  return Effect.catch(
    execProcess(
      "gh",
      ["pr", "checks", String(prNumber), "--json", "name,state"],
      { cwd },
    ).pipe(Effect.map((result) => parseGhPrChecks(result.stdout.trim()))),
    () => Effect.succeed([] as PrCheckInfo[]),
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

        if (pr.isCrossRepository) {
          pr.forkOwner = data.headRepositoryOwner?.login;
          pr.forkRepo = data.headRepository?.name;
        }

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
        ["fetch", remote, branch],
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
      commandError("pr_error", "Failed to list PRs", error),
    ),
  listPrChecks: (cwd, prNumber) =>
    Effect.mapError(listPrChecksImpl(cwd, prNumber), (error) =>
      commandError(
        "pr_error",
        `Failed to list checks for PR #${prNumber}`,
        error,
      ),
    ),
});

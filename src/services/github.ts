import { $ } from "bun";

const GITHUB_PR_URL_PATTERN =
  /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/;

/**
 * Parse a --pr value into a numeric PR number.
 * Accepts either a plain number ("123") or a full GitHub PR URL.
 * Returns null if the value cannot be parsed.
 */
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

/**
 * Check whether the `gh` CLI is available on the system.
 */
export async function isGhInstalled(): Promise<boolean> {
  try {
    await $`gh --version`.quiet();
    return true;
  } catch {
    return false;
  }
}

export interface PrInfo {
  branch: string;
  prNumber: number;
  isCrossRepository: boolean;
  forkOwner?: string;
  forkRepo?: string;
}

function extractShellError(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    return (err as { stderr: Buffer }).stderr.toString().trim();
  }
  return String(err);
}

/**
 * Resolve a PR number to its metadata using the `gh` CLI.
 * Returns branch name, and fork info when the PR is cross-repository.
 */
export async function resolvePr(
  prNumber: number,
): Promise<{ success: boolean; pr?: PrInfo; error?: string }> {
  try {
    const result =
      await $`gh pr view ${prNumber} --json headRefName,isCrossRepository,headRepositoryOwner,headRepository`.quiet();
    const data = JSON.parse(result.text().trim());

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
      return { success: false, error: `PR #${prNumber} has no head branch` };
    }

    return { success: true, pr };
  } catch (err) {
    return { success: false, error: extractShellError(err) };
  }
}

/**
 * Add a git remote for a fork repository.
 * Uses the same protocol (SSH/HTTPS) as the origin remote.
 * No-op if the remote already exists.
 */
export async function addForkRemote(
  remoteName: string,
  owner: string,
  repo: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await $`git remote get-url ${remoteName}`.quiet();
    return { success: true };
  } catch {
    // Remote doesn't exist yet, will add below
  }

  let url: string;
  try {
    const originUrl = (await $`git remote get-url origin`.quiet())
      .text()
      .trim();
    if (originUrl.startsWith("git@") || originUrl.includes("ssh://")) {
      url = `git@github.com:${owner}/${repo}.git`;
    } else {
      url = `https://github.com/${owner}/${repo}.git`;
    }
  } catch {
    url = `https://github.com/${owner}/${repo}.git`;
  }

  try {
    await $`git remote add ${remoteName} ${url}`.quiet();
    return { success: true };
  } catch (err) {
    return { success: false, error: extractShellError(err) };
  }
}

/**
 * Fetch a branch from a remote so it is available locally.
 */
export async function fetchBranch(
  branch: string,
  remote = "origin",
): Promise<{ success: boolean; error?: string }> {
  try {
    await $`git fetch ${remote} ${branch}`.quiet();
    return { success: true };
  } catch (err) {
    return { success: false, error: extractShellError(err) };
  }
}

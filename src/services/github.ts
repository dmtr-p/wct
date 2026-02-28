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

export interface ResolvePrResult {
  success: boolean;
  branch?: string;
  error?: string;
}

/**
 * Resolve a PR number to its head branch name using the `gh` CLI.
 */
export async function resolvePrBranch(
  prNumber: number,
): Promise<ResolvePrResult> {
  try {
    const result =
      await $`gh pr view ${prNumber} --json headRefName --jq .headRefName`.quiet();
    const branch = result.text().trim();
    if (!branch) {
      return { success: false, error: `PR #${prNumber} has no head branch` };
    }
    return { success: true, branch };
  } catch (err) {
    const message =
      err && typeof err === "object" && "stderr" in err
        ? (err as { stderr: Buffer }).stderr.toString().trim()
        : String(err);
    return { success: false, error: message };
  }
}

/**
 * Fetch a branch from the remote so it is available locally.
 * Uses `git fetch origin <branch>` to retrieve the ref.
 */
export async function fetchBranch(branch: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    await $`git fetch origin ${branch}`.quiet();
    return { success: true };
  } catch (err) {
    const message =
      err && typeof err === "object" && "stderr" in err
        ? (err as { stderr: Buffer }).stderr.toString().trim()
        : String(err);
    return { success: false, error: message };
  }
}

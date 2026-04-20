import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { resolveOpenOptions } from "../src/commands/open";
import { runBunPromise } from "../src/effect/runtime";
import {
  liveGitHubService,
  type GitHubService,
} from "../src/services/github-service";
import {
  liveWorktreeService,
  type WorktreeService,
} from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

async function runResolveOpenOptions(
  input: Parameters<typeof resolveOpenOptions>[0],
  overrides: { github?: GitHubService; worktree?: WorktreeService } = {},
) {
  return runBunPromise(withTestServices(resolveOpenOptions(input), overrides));
}

describe("resolveOpenOptions", () => {
  test("rejects branch argument together with --pr", async () => {
    await expect(
      runResolveOpenOptions({
        branch: "feature-branch",
        pr: "123",
      }),
    ).rejects.toThrow("Cannot use --pr together with a branch argument");
  });

  test("normalizes PR options into branch and base after fetching", async () => {
    const calls: Array<{ branch: string; remote?: string }> = [];
    const githubOverrides: GitHubService = {
      ...liveGitHubService,
      isGhInstalled: () => Effect.succeed(true),
      resolvePr: (prNumber: number) =>
        Effect.succeed({
          branch: "feature-from-pr",
          prNumber,
          isCrossRepository: false,
          headOwner: "acme",
          headRepo: "wct",
        }),
      findRemoteForRepo: () => Effect.succeed("origin"),
      fetchBranch: (branch: string, remote?: string) =>
        Effect.sync(() => {
          calls.push({ branch, remote });
        }),
    };
    const worktreeOverrides: WorktreeService = {
      ...liveWorktreeService,
      branchExists: () => Effect.succeed(false),
    };

    await expect(
      runResolveOpenOptions(
        {
          pr: "123",
          noIde: true,
          noAttach: true,
          prompt: "focus",
          profile: "default",
        },
        {
          github: githubOverrides,
          worktree: worktreeOverrides,
        },
      ),
    ).resolves.toEqual({
      branch: "feature-from-pr",
      existing: false,
      base: "origin/feature-from-pr",
      noIde: true,
      noAttach: true,
      prompt: "focus",
      profile: "default",
    });

    expect(calls).toEqual([
      {
        branch: "feature-from-pr",
        remote: "origin",
      },
    ]);
  });
});

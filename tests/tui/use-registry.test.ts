import { describe, expect, test, vi } from "vitest";
import { loadRepoInfo } from "../../src/tui/hooks/useRegistry";

describe("loadRepoInfo", () => {
  test("returns a repo-level error instead of throwing when inspection fails", async () => {
    const repo = {
      id: "1",
      repo_path: "/repo",
      project: "demo",
    };

    await expect(
      loadRepoInfo(repo, {
        pathExists: () => true,
        getProfileNames: () => ["default"],
        listWorktrees: () => Promise.reject(new Error("bad repo")),
        getDefaultBranch: () => Promise.resolve("origin/main"),
        getChangedFileCount: vi.fn(),
        getAheadBehind: vi.fn(),
      }),
    ).resolves.toEqual({
      id: "1",
      repoPath: "/repo",
      project: "demo",
      worktrees: [],
      profileNames: ["default"],
      error: "Failed to inspect repository",
    });
  });

  test("falls back to zero/null worktree status when per-worktree inspection fails", async () => {
    const repo = {
      id: "1",
      repo_path: "/repo",
      project: "demo",
    };

    await expect(
      loadRepoInfo(repo, {
        pathExists: () => true,
        getProfileNames: () => [],
        listWorktrees: () =>
          Promise.resolve([
            {
              branch: "feature",
              path: "/repo-feature",
              commit: "abc",
              isBare: false,
            },
          ]),
        getDefaultBranch: () => Promise.resolve("origin/main"),
        getChangedFileCount: () => Promise.reject(new Error("status failed")),
        getAheadBehind: () => Promise.reject(new Error("sync failed")),
      }),
    ).resolves.toEqual({
      id: "1",
      repoPath: "/repo",
      project: "demo",
      worktrees: [
        {
          branch: "feature",
          path: "/repo-feature",
          isMainWorktree: true,
          changedFiles: 0,
          sync: null,
        },
      ],
      profileNames: [],
    });
  });
});

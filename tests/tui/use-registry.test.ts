import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { getIdeDefaults, loadRepoInfo } from "../../src/tui/hooks/useRegistry";

const defaultIdeDefaults = { baseNoIde: true, profileNoIde: {} };

describe("getIdeDefaults", () => {
  test("defaults to no IDE when config cannot be loaded", async () => {
    await withIsolatedHome(async () => {
      await expect(getIdeDefaults("/missing")).resolves.toEqual({
        baseNoIde: true,
        profileNoIde: {},
      });
    });
  });

  test("base config with ide object defaults No IDE unchecked", async () => {
    await withConfigFixture(
      `ide:
  command: "cursor $WCT_WORKTREE_DIR"
`,
      async (repoPath) => {
        await expect(getIdeDefaults(repoPath)).resolves.toEqual({
          baseNoIde: false,
          profileNoIde: {},
        });
      },
    );
  });

  test("profile ide.open false defaults No IDE checked for that profile", async () => {
    await withConfigFixture(
      `ide:
  command: "cursor $WCT_WORKTREE_DIR"
profiles:
  quiet:
    ide:
      open: false
`,
      async (repoPath) => {
        await expect(getIdeDefaults(repoPath)).resolves.toEqual({
          baseNoIde: false,
          profileNoIde: {
            quiet: true,
          },
        });
      },
    );
  });

  test("profile ide object defaults No IDE unchecked when base has no ide", async () => {
    await withConfigFixture(
      `profiles:
  cursor:
    ide:
      command: "cursor $WCT_WORKTREE_DIR"
`,
      async (repoPath) => {
        await expect(getIdeDefaults(repoPath)).resolves.toEqual({
          baseNoIde: true,
          profileNoIde: {
            cursor: false,
          },
        });
      },
    );
  });
});

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
        getIdeDefaults: () => Promise.resolve(defaultIdeDefaults),
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
      ideDefaults: defaultIdeDefaults,
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
        getIdeDefaults: () => Promise.resolve(defaultIdeDefaults),
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
      ideDefaults: defaultIdeDefaults,
    });
  });
});

async function withIsolatedHome(run: () => Promise<void>): Promise<void> {
  const homeDir = mkdtempSync(join(tmpdir(), "wct-tui-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    await run();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(homeDir, { recursive: true, force: true });
  }
}

async function withConfigFixture(
  content: string,
  run: (repoPath: string) => Promise<void>,
): Promise<void> {
  const repoPath = mkdtempSync(join(tmpdir(), "wct-tui-registry-"));
  writeFileSync(join(repoPath, ".wct.yaml"), content);
  try {
    await withIsolatedHome(() => run(repoPath));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React, { type FC } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Worktree } from "../../src/services/worktree-service";

// `useRegistry` reaches services through `tuiRuntime`, so `XService.use(selector)`
// is mocked to resolve synchronously against a controllable fake.
const registryFixtures = vi.hoisted(() => ({
  listRepos: vi.fn(),
}));

const worktreeFixtures = vi.hoisted(() => ({
  listWorktrees: vi.fn(),
}));

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn((effect: unknown) => Promise.resolve(effect)),
  },
}));

vi.mock("../../src/services/registry-service", () => ({
  RegistryService: {
    use: (selector: (service: unknown) => unknown) =>
      selector({ listRepos: registryFixtures.listRepos }),
  },
}));

vi.mock("../../src/services/worktree-service", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/services/worktree-service")
  >("../../src/services/worktree-service");
  return {
    ...actual,
    WorktreeService: {
      use: (selector: (service: unknown) => unknown) =>
        selector({
          listWorktrees: worktreeFixtures.listWorktrees,
          getDefaultBranch: () => Promise.resolve("main"),
          getChangedFileCount: () => Promise.resolve(0),
          getAheadBehind: () => Promise.resolve({ ahead: 0, behind: 0 }),
        }),
    },
  };
});

const { loadRepoInfo, useRegistry } = await import(
  "../../src/tui/hooks/useRegistry"
);

type RegistryHookValue = ReturnType<typeof useRegistry>;

async function renderUseRegistry() {
  let latest: RegistryHookValue | undefined;
  const Wrapper: FC = () => {
    latest = useRegistry();
    return null;
  };
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 80;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => NodeJS.ReadStream;
  };
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  const { render } = await import("ink");
  const instance = render(React.createElement(Wrapper), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  return {
    get value() {
      if (!latest) throw new Error("Hook not captured");
      return latest;
    },
    unmount: () => instance.unmount(),
  };
}

function worktreeOf(repoPath: string, branch: string): Worktree {
  return {
    branch,
    path: join(repoPath, branch.replaceAll("/", "-")),
    commit: "abc",
    isBare: false,
  };
}

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

describe("useRegistry refresh", () => {
  // The hook inspects repo_path on disk, so the fixture repo must really exist.
  let repoPath: string;
  let homeDir: string;

  beforeEach(() => {
    registryFixtures.listRepos.mockReset();
    worktreeFixtures.listWorktrees.mockReset();
    repoPath = mkdtempSync(join(tmpdir(), "wct-use-registry-repo-"));
    homeDir = mkdtempSync(join(tmpdir(), "wct-use-registry-home-"));
    vi.stubEnv("HOME", homeDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  test("resolves the repos it just loaded", async () => {
    registryFixtures.listRepos.mockResolvedValue([
      { id: "r1", repo_path: repoPath, project: "alpha" },
    ]);
    worktreeFixtures.listWorktrees.mockResolvedValue([
      worktreeOf(repoPath, "feature/x"),
    ]);

    const hook = await renderUseRegistry();
    const snapshot = await hook.value.refresh();

    expect(snapshot).not.toBeNull();
    expect(snapshot).toHaveLength(1);
    expect(snapshot?.[0]).toMatchObject({
      id: "r1",
      repoPath,
      project: "alpha",
      worktrees: [expect.objectContaining({ branch: "feature/x" })],
    });
    expect(hook.value.repos).toEqual(snapshot);
    expect(hook.value.loading).toBe(false);
    hook.unmount();
  });

  test("resolves null and keeps the previous repos when the load fails", async () => {
    registryFixtures.listRepos.mockResolvedValue([
      { id: "r1", repo_path: repoPath, project: "alpha" },
    ]);
    worktreeFixtures.listWorktrees.mockResolvedValue([
      worktreeOf(repoPath, "feature/x"),
    ]);

    const hook = await renderUseRegistry();
    const loaded = await hook.value.refresh();
    expect(loaded).toHaveLength(1);

    registryFixtures.listRepos.mockRejectedValue(new Error("registry gone"));
    const failed = await hook.value.refresh();

    expect(failed).toBeNull();
    expect(hook.value.repos).toEqual(loaded);
    hook.unmount();
  });
});

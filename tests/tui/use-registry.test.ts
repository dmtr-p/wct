import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Effect, FileSystem } from "effect";
import React, { type FC } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConfigError } from "../../src/config/loader";
import type { Worktree } from "../../src/services/worktree-service";

// `useRegistry` reaches services through `tuiRuntime`, so `XService.use(selector)`
// is mocked to resolve synchronously against a controllable fake.
const registryFixtures = vi.hoisted(() => ({
  listRepos: vi.fn(),
}));

const worktreeFixtures = vi.hoisted(() => ({
  listWorktrees: vi.fn(),
}));

vi.mock("../../src/tui/runtime", async () => {
  const { Effect } = await import("effect");
  const { runBunPromise } = await import("../../src/effect/runtime");
  return {
    tuiRuntime: {
      runPromise: vi.fn(
        (
          effect:
            | Effect.Effect<unknown, ConfigError, FileSystem.FileSystem>
            | Promise<unknown>,
        ) =>
          Effect.isEffect(effect)
            ? runBunPromise(effect)
            : Promise.resolve(effect),
      ),
    },
  };
});

vi.mock("../../src/services/registry-service", () => ({
  RegistryService: {
    use: (selector: (service: unknown) => unknown) =>
      selector({ listRepos: registryFixtures.listRepos() }),
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

const { loadRepoInfo, useRegistry } =
  await import("../../src/tui/hooks/useRegistry");

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
  test("keeps missing worktrees selectable without querying their status", async () => {
    const missing = worktreeOf("/repo", "missing");
    const getChangedFileCount = vi.fn(async () => 2);
    const getAheadBehind = vi.fn(async () => ({ ahead: 1, behind: 0 }));
    const result = await loadRepoInfo(
      { id: "1", repo_path: "/repo", project: "demo" },
      {
        pathExists: (path) => path !== missing.path,
        getProfileNames: async () => [],
        listWorktrees: async () => [worktreeOf("/repo", "main"), missing],
        getDefaultBranch: async () => "origin/main",
        getChangedFileCount,
        getAheadBehind,
      },
    );

    expect(result.worktrees[1]).toEqual({
      branch: "missing",
      path: missing.path,
      isMainWorktree: false,
      changedFiles: 0,
      sync: null,
    });
    expect(getChangedFileCount.mock.calls).toEqual([["/repo/main"]]);
    expect(getAheadBehind.mock.calls).toEqual([["/repo/main", "origin/main"]]);
  });

  test("returns a repo-level error instead of throwing when inspection fails", async () => {
    const repo = {
      id: "1",
      repo_path: "/repo",
      project: "demo",
    };

    await expect(
      loadRepoInfo(repo, {
        pathExists: () => true,
        getProfileNames: async () => ["default"],
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
        getProfileNames: async () => [],
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

  test.each([false, true])(
    "isolates profile loading failure from repository inspection (inspection fails: %s)",
    async (inspectionFails) => {
      const result = await loadRepoInfo(
        { id: "1", repo_path: "/repo", project: "demo" },
        {
          pathExists: () => true,
          getProfileNames: async () => {
            throw new Error("invalid config");
          },
          listWorktrees: async () => {
            if (inspectionFails) throw new Error("bad repo");
            return [worktreeOf("/repo", "main")];
          },
          getDefaultBranch: async () => "origin/main",
          getChangedFileCount: async () => 2,
          getAheadBehind: async () => ({ ahead: 1, behind: 0 }),
        },
      );

      expect(result.profileNames).toEqual([]);
      expect(result.error).toBe(
        inspectionFails ? "Failed to inspect repository" : undefined,
      );
      expect(result.worktrees).toHaveLength(inspectionFails ? 0 : 1);
    },
  );
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
    registryFixtures.listRepos.mockResolvedValue([
      { id: "r1", repo_path: repoPath, project: "alpha" },
    ]);
    worktreeFixtures.listWorktrees.mockResolvedValue([
      worktreeOf(repoPath, "feature/x"),
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  test.each([
    {
      name: "no config files",
      project: undefined,
      global: undefined,
      expected: [],
    },
    {
      name: "valid config without profiles",
      project: "project_name: demo\n",
      global: undefined,
      expected: [],
    },
    {
      name: "project profile names in definition order",
      project: "profiles:\n  z-dev: {}\n  2.review: {}\n  a_test: {}\n",
      global: undefined,
      expected: ["z-dev", "2.review", "a_test"],
    },
    {
      name: "global profiles without project config",
      project: undefined,
      global: "profiles:\n  inherited: {}\n",
      expected: ["inherited"],
    },
    {
      name: "global profiles with absent project profiles",
      project: "project_name: demo\n",
      global: "profiles:\n  inherited: {}\n",
      expected: ["inherited"],
    },
    {
      name: "project profiles replace global profiles",
      project: "profiles:\n  local: {}\n",
      global: "profiles:\n  inherited: {}\n",
      expected: ["local"],
    },
    {
      name: "empty project profiles replace global profiles",
      project: "profiles: {}\n",
      global: "profiles:\n  inherited: {}\n",
      expected: [],
    },
    {
      name: "invalid project profile name",
      project: 'profiles:\n  "bad name": {}\n',
      global: "profiles:\n  inherited: {}\n",
      expected: [],
    },
    {
      name: "malformed project profile",
      project: "profiles:\n  local: false\n",
      global: undefined,
      expected: [],
    },
    {
      name: "invalid inherited profile name",
      project: "project_name: demo\n",
      global: 'profiles:\n  "bad name": {}\n',
      expected: [],
    },
    {
      name: "malformed inherited profile",
      project: undefined,
      global: "profiles:\n  inherited:\n    setup: false\n",
      expected: [],
    },
    {
      name: "invalid project YAML",
      project: "profiles: [\n",
      global: "profiles:\n  inherited: {}\n",
      expected: [],
    },
    {
      name: "invalid global YAML with valid project profiles",
      project: "profiles:\n  local: {}\n",
      global: "profiles: [\n",
      expected: [],
    },
    {
      name: "invalid project work directory",
      project: "work_dir: /absolute\nprofiles:\n  local: {}\n",
      global: undefined,
      expected: [],
    },
    {
      name: "invalid global configuration with valid project profiles",
      project: "profiles:\n  local: {}\n",
      global: "copy: false\n",
      expected: [],
    },
    {
      name: "invalid merged tmux configuration",
      project: "tmux: {}\nprofiles:\n  local: {}\n",
      global: 'tmux:\n  windows:\n    - name: "bad name"\n',
      expected: [],
    },
    {
      name: "invalid profile work directory",
      project: "profiles:\n  local:\n    work_dir: /absolute\n",
      global: undefined,
      expected: [],
    },
    {
      name: "invalid profile tmux configuration",
      project:
        'profiles:\n  local:\n    tmux:\n      windows:\n        - name: "bad name"\n',
      global: undefined,
      expected: [],
    },
  ])("loads validated profiles: $name", async ({ project, global, expected }) => {
    if (project !== undefined) {
      writeFileSync(join(repoPath, ".wct.yaml"), project);
    }
    if (global !== undefined) {
      writeFileSync(join(homeDir, ".wct.yaml"), global);
    }

    const hook = await renderUseRegistry();
    try {
      const snapshot = await hook.value.refresh();
      expect(snapshot).toHaveLength(1);
      expect(snapshot?.[0]).toMatchObject({
        profileNames: expected,
        worktrees: [expect.objectContaining({ branch: "feature/x" })],
      });
      expect(snapshot?.[0].error).toBeUndefined();
    } finally {
      hook.unmount();
    }
  });

  test.each(["project", "global"])(
    "keeps worktrees available when the %s config cannot be read",
    async (source) => {
      const unreadableDir = source === "project" ? repoPath : homeDir;
      const validDir = source === "project" ? homeDir : repoPath;
      mkdirSync(join(unreadableDir, ".wct.yaml"));
      writeFileSync(join(validDir, ".wct.yaml"), "profiles:\n  valid: {}\n");

      const hook = await renderUseRegistry();
      try {
        const snapshot = await hook.value.refresh();
        expect(snapshot).toHaveLength(1);
        expect(snapshot?.[0]).toMatchObject({
          profileNames: [],
          worktrees: [expect.objectContaining({ branch: "feature/x" })],
        });
        expect(snapshot?.[0].error).toBeUndefined();
      } finally {
        hook.unmount();
      }
    },
  );

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

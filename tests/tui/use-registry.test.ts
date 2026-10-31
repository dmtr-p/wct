import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Effect } from "effect";
import React, { type FC } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { commandError } from "../../src/errors";
import { RegistrationId } from "../../src/services/identities";
import type {
  Worktree,
  WorktreeStatusOptions,
} from "../../src/services/worktree-service";

const registryFixtures = vi.hoisted(() => ({
  listRepos: vi.fn(),
}));

const worktreeFixtures = vi.hoisted(() => ({
  listWorktrees: vi.fn(),
  getChangedFileCount:
    vi.fn<
      (worktreePath: string, options?: WorktreeStatusOptions) => Promise<number>
    >(),
  getAheadBehind:
    vi.fn<
      (
        worktreePath: string,
        ref: string,
        options?: WorktreeStatusOptions,
      ) => Promise<{ ahead: number; behind: number } | null>
    >(),
}));

const runtimeFixtures = vi.hoisted(() => ({
  runPromise: vi.fn(),
}));

const watchFixtures = vi.hoisted(() => ({
  callback: null as ((event: string, filename: string) => void) | null,
}));

vi.mock("node:fs", async () => ({
  ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
  watch: (
    _path: string,
    callback: (event: string, filename: string) => void,
  ) => {
    watchFixtures.callback = callback;
    return {
      close: () => {
        watchFixtures.callback = null;
      },
    };
  },
}));

vi.mock("../../src/tui/runtime", async () => {
  const { Effect } = await import("effect");
  const { provideBunServices } = await import("../../src/effect/runtime");
  const { RegistryService, liveRegistryService } =
    await import("../../src/services/registry-service");
  const { WorktreeService } =
    await import("../../src/services/worktree-service");
  const { TmuxService } = await import("../../src/services/tmux");
  const { noopTmuxService } = await import("../helpers/services");
  const { LocalObservationService, makeLocalObservationService } =
    await import("../../src/services/local-observation-service");
  const { liveWorktreeService, makeWorktreeService } =
    await import("../../src/services/worktree-service");
  const fake = <A>(read: () => Promise<A>) =>
    Effect.tryPromise({
      try: () => read(),
      catch: (error) => commandError("unexpected_error", String(error), error),
    });
  const worktree = await Effect.runPromise(
    provideBunServices(
      makeWorktreeService({
        ...liveWorktreeService,
        listWorktrees: (path?: string) =>
          fake(() => worktreeFixtures.listWorktrees(path)),
        getDefaultBranch: () => Effect.succeed("main"),
        getChangedFileCount: (path: string, options?: WorktreeStatusOptions) =>
          fake(() => worktreeFixtures.getChangedFileCount(path, options)),
        getAheadBehind: (
          path: string,
          ref: string,
          options?: WorktreeStatusOptions,
        ) => fake(() => worktreeFixtures.getAheadBehind(path, ref, options)),
      }),
    ),
  );
  const observation = await Effect.runPromise(
    provideBunServices(
      makeLocalObservationService.pipe(
        Effect.provideService(RegistryService, {
          ...liveRegistryService,
          listRepos: Effect.suspend(() =>
            fake(() => registryFixtures.listRepos()),
          ),
        }),
        Effect.provideService(WorktreeService, worktree),
        Effect.provideService(TmuxService, noopTmuxService),
      ),
    ),
  );
  return {
    tuiRuntime: {
      runPromise: runtimeFixtures.runPromise.mockImplementation(
        (effect: Effect.Effect<unknown>, options?: { signal?: AbortSignal }) =>
          Effect.runPromise(
            provideBunServices(
              Effect.provideService(
                effect,
                LocalObservationService,
                observation,
              ),
            ),
            options,
          ),
      ),
    },
  };
});

const { useRegistry } = await import("../../src/tui/hooks/useRegistry");
const { useRefresh } = await import("../../src/tui/hooks/useRefresh");

import type { ResolvedConfig } from "../../src/config/schema";
import type { RegistryRepoItem } from "../../src/services/local-observation-service";
import { inspectRepository } from "../../src/services/local-observation-service";
interface LoadRepoInfoDeps {
  pathExists: (path: string) => boolean;
  getConfig: (
    repoPath: string,
  ) => Promise<Pick<ResolvedConfig, "profiles" | "base_branch">>;
  listWorktrees: (
    repoPath: string,
  ) => Promise<import("../../src/services/worktree-service").Worktree[]>;
  getDefaultBranch: (repoPath: string) => Promise<string | null>;
  getChangedFileCount: (worktreePath: string) => Promise<number>;
  getAheadBehind: (
    worktreePath: string,
    ref: string,
  ) => Promise<{ ahead: number; behind: number } | null>;
}

function loadRepoInfo(
  item: RegistryRepoItem,
  deps: LoadRepoInfoDeps,
  signal?: AbortSignal,
) {
  const read = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({
      try: () => f(),
      catch: (error) => commandError("unexpected_error", String(error), error),
    });
  return Effect.runPromise(
    inspectRepository(item, {
      pathExists: deps.pathExists,
      getConfig: (path) => read(() => deps.getConfig(path)),
      listWorktrees: (path) => read(() => deps.listWorktrees(path)),
      getDefaultBranch: (path) => read(() => deps.getDefaultBranch(path)),
      getChangedFileCount: (path) => read(() => deps.getChangedFileCount(path)),
      getAheadBehind: (path, ref) => read(() => deps.getAheadBehind(path, ref)),
    }),
    signal ? { signal } : undefined,
  );
}
type RegistryHookValue = ReturnType<typeof useRegistry>;

async function renderUseRegistry(polling = false) {
  let latest: RegistryHookValue | undefined;
  let background: Promise<unknown> | undefined;
  const Wrapper: FC = () => {
    latest = useRegistry();
    return null;
  };
  const PollingWrapper: FC = () => {
    const value = useRegistry();
    latest = value;
    useRefresh(async () => {
      background = value.refresh();
      await background;
    });
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
  const instance = render(
    React.createElement(polling ? PollingWrapper : Wrapper),
    {
      stdout,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  return {
    get background() {
      return background;
    },
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
      { id: RegistrationId("1"), repo_path: "/repo", project: "demo" },
      {
        pathExists: (path) => path !== missing.path,
        getConfig: async () => ({}),
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
      id: RegistrationId("1"),
      repo_path: "/repo",
      project: "demo",
    };

    await expect(
      loadRepoInfo(repo, {
        pathExists: () => true,
        getConfig: async () => ({ profiles: { default: {} } }),
        listWorktrees: () => Promise.reject(new Error("bad repo")),
        getDefaultBranch: () => Promise.resolve("origin/main"),
        getChangedFileCount: vi.fn(),
        getAheadBehind: vi.fn(),
      }),
    ).resolves.toEqual({
      id: RegistrationId("1"),
      repoPath: "/repo",
      project: "demo",
      worktrees: [],
      profileNames: ["default"],
      error: "Failed to inspect repository",
    });
  });

  test("falls back to zero/null worktree status when per-worktree inspection fails", async () => {
    const repo = {
      id: RegistrationId("1"),
      repo_path: "/repo",
      project: "demo",
    };

    await expect(
      loadRepoInfo(repo, {
        pathExists: () => true,
        getConfig: async () => ({}),
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
      id: RegistrationId("1"),
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
        { id: RegistrationId("1"), repo_path: "/repo", project: "demo" },
        {
          pathExists: () => true,
          getConfig: async () => {
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

  test("propagates cancellation during profile loading", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    await expect(
      loadRepoInfo(
        { id: RegistrationId("1"), repo_path: "/repo", project: "demo" },
        {
          pathExists: () => true,
          getConfig: async () => {
            controller.abort(reason);
            throw reason;
          },
          listWorktrees: async () => [worktreeOf("/repo", "main")],
          getDefaultBranch: async () => "main",
          getChangedFileCount: async () => 0,
          getAheadBehind: async () => null,
        },
        controller.signal,
      ),
    ).rejects.toBeDefined();
  });
});

describe("useRegistry refresh", () => {
  // The hook inspects repo_path on disk, so the fixture repo must really exist.
  let repoPath: string;
  let homeDir: string;

  beforeEach(() => {
    registryFixtures.listRepos.mockReset();
    worktreeFixtures.listWorktrees.mockReset();
    worktreeFixtures.getChangedFileCount.mockReset().mockResolvedValue(0);
    worktreeFixtures.getAheadBehind
      .mockReset()
      .mockResolvedValue({ ahead: 0, behind: 0 });
    repoPath = mkdtempSync(join(tmpdir(), "wct-use-registry-repo-"));
    homeDir = mkdtempSync(join(tmpdir(), "wct-use-registry-home-"));
    vi.stubEnv("HOME", homeDir);
    registryFixtures.listRepos.mockResolvedValue([
      { id: RegistrationId("r1"), repo_path: repoPath, project: "alpha" },
    ]);
    worktreeFixtures.listWorktrees.mockResolvedValue([
      worktreeOf(repoPath, "feature/x"),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  test("suppresses status warnings and refreshes healthy worktrees and repos when status reads fail", async () => {
    const otherRepoPath = join(repoPath, "other-repo");
    const failed = worktreeOf(repoPath, "failed");
    const healthy = worktreeOf(repoPath, "healthy");
    const other = worktreeOf(otherRepoPath, "main");
    for (const wt of [failed, healthy, other]) {
      mkdirSync(wt.path, { recursive: true });
    }
    registryFixtures.listRepos.mockResolvedValue([
      { id: RegistrationId("r1"), repo_path: repoPath, project: "alpha" },
      { id: RegistrationId("r2"), repo_path: otherRepoPath, project: "beta" },
    ]);
    worktreeFixtures.listWorktrees.mockImplementation(async (path: string) =>
      path === repoPath ? [failed, healthy] : [other],
    );
    worktreeFixtures.getChangedFileCount.mockImplementation(async (path) => {
      if (path === failed.path) throw new Error("status failed");
      return path === healthy.path ? 2 : 3;
    });
    worktreeFixtures.getAheadBehind.mockImplementation(async (path) => {
      if (path === failed.path) throw new Error("sync failed");
      return { ahead: path === healthy.path ? 1 : 2, behind: 0 };
    });

    const hook = await renderUseRegistry();
    try {
      const snapshot = await hook.value.refresh();

      for (const wt of [failed, healthy, other]) {
        expect(worktreeFixtures.getChangedFileCount).toHaveBeenCalledWith(
          wt.path,
          { logWarnings: false },
        );
        expect(worktreeFixtures.getAheadBehind).toHaveBeenCalledWith(
          wt.path,
          "main",
          { logWarnings: false },
        );
      }
      expect(snapshot).toMatchObject([
        {
          id: RegistrationId("r1"),
          worktrees: [
            { path: failed.path, changedFiles: 0, sync: null },
            {
              path: healthy.path,
              changedFiles: 2,
              sync: { ahead: 1, behind: 0 },
            },
          ],
        },
        {
          id: RegistrationId("r2"),
          worktrees: [
            {
              path: other.path,
              changedFiles: 3,
              sync: { ahead: 2, behind: 0 },
            },
          ],
        },
      ]);
    } finally {
      hook.unmount();
    }
  });

  test.each(["poll", "watch"])(
    "keeps a newer direct refresh when an older %s scan finishes last",
    async (trigger) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const hook = await renderUseRegistry(true);
      const pending =
        Promise.withResolvers<
          { id: RegistrationId; repo_path: string; project: string }[]
        >();
      const started = Promise.withResolvers<void>();
      try {
        registryFixtures.listRepos.mockImplementationOnce(() => {
          started.resolve();
          return pending.promise;
        });
        if (trigger === "poll") vi.advanceTimersByTime(5000);
        else {
          expect(watchFixtures.callback).not.toBeNull();
          watchFixtures.callback?.("change", "wct.db-wal");
        }
        await started.promise;

        registryFixtures.listRepos.mockResolvedValueOnce([]);
        expect(await hook.value.refresh()).toEqual([]);
        pending.resolve([
          { id: RegistrationId("r1"), repo_path: repoPath, project: "removed" },
        ]);
        await hook.background;
        for (let i = 0; i < 6; i++)
          await new Promise((resolve) => setTimeout(resolve, 0));
        expect(hook.value.repos).toEqual([]);
      } finally {
        pending.resolve([]);
        await hook.background;
        hook.unmount();
      }
    },
  );

  test("returns each lifecycle caller's post-request snapshot despite supersession", async () => {
    const hook = await renderUseRegistry();
    const pending =
      Promise.withResolvers<
        { id: RegistrationId; repo_path: string; project: string }[]
      >();
    try {
      registryFixtures.listRepos.mockReturnValueOnce(pending.promise);
      const first = hook.value.refresh();
      registryFixtures.listRepos.mockResolvedValueOnce([]);
      expect(await hook.value.refresh()).toEqual([]);
      pending.resolve([
        { id: RegistrationId("r1"), repo_path: repoPath, project: "first" },
      ]);
      expect((await first)?.[0]?.project).toBe("first");
      for (let i = 0; i < 6; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
      expect(hook.value.repos).toEqual([]);
    } finally {
      pending.resolve([]);
      hook.unmount();
    }
  });

  test("publishes slow scans across successive polls while newer scans remain pending", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    type Item = { id: RegistrationId; repo_path: string; project: string };
    const initial = Promise.withResolvers<Item[]>();
    const second = Promise.withResolvers<Item[]>();
    const third = Promise.withResolvers<Item[]>();
    registryFixtures.listRepos.mockReturnValueOnce(initial.promise);
    const hook = await renderUseRegistry(true);
    const items = (project: string): Item[] => [
      {
        id: RegistrationId(project),
        repo_path: join(repoPath, "missing"),
        project,
      },
    ];
    try {
      expect(hook.value.loading).toBe(true);
      registryFixtures.listRepos.mockReturnValueOnce(second.promise);
      vi.advanceTimersByTime(5000);
      const secondRefresh = hook.background;
      initial.resolve(items("first"));
      for (let i = 0; i < 6; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
      expect(hook.value.loading).toBe(false);
      expect(hook.value.repos[0]?.project).toBe("first");

      registryFixtures.listRepos.mockReturnValueOnce(third.promise);
      vi.advanceTimersByTime(5000);
      second.resolve(items("second"));
      await secondRefresh;
      for (let i = 0; i < 6; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
      expect(hook.value.repos[0]?.project).toBe("second");

      third.resolve([]);
      await hook.background;
      for (let i = 0; i < 6; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
      expect(hook.value.repos).toEqual([]);
    } finally {
      initial.resolve([]);
      second.resolve([]);
      third.resolve([]);
      await hook.background;
      hook.unmount();
    }
  });

  test("discards a direct refresh that finishes after unmount", async () => {
    const hook = await renderUseRegistry();
    const pending = Promise.withResolvers<never[]>();
    registryFixtures.listRepos.mockReturnValueOnce(pending.promise);
    const refreshing = hook.value.refresh();
    hook.unmount();
    pending.resolve([]);
    expect(await refreshing).toBeNull();
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
  ])(
    "loads validated profiles: $name",
    async ({ project, global, expected }) => {
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
        expect(snapshot?.[0]?.error).toBeUndefined();
      } finally {
        hook.unmount();
      }
    },
  );

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
        expect(snapshot?.[0]?.error).toBeUndefined();
      } finally {
        hook.unmount();
      }
    },
  );

  test("resolves the repos it just loaded", async () => {
    registryFixtures.listRepos.mockResolvedValue([
      { id: RegistrationId("r1"), repo_path: repoPath, project: "alpha" },
    ]);
    worktreeFixtures.listWorktrees.mockResolvedValue([
      worktreeOf(repoPath, "feature/x"),
    ]);

    const hook = await renderUseRegistry();
    const snapshot = await hook.value.refresh();

    expect(snapshot).not.toBeNull();
    expect(snapshot).toHaveLength(1);
    expect(snapshot?.[0]).toMatchObject({
      id: RegistrationId("r1"),
      repoPath,
      project: "alpha",
      worktrees: [expect.objectContaining({ branch: "feature/x" })],
    });
    expect(hook.value.repos).toEqual(snapshot);
    expect(hook.value.loading).toBe(false);
    hook.unmount();
  });

  test.each([undefined, "develop"])(
    "loads the merged base branch for the Open modal (project: %s)",
    async (projectBase) => {
      writeFileSync(join(homeDir, ".wct.yaml"), "base_branch: upstream/main\n");
      if (projectBase)
        writeFileSync(
          join(repoPath, ".wct.yaml"),
          `base_branch: ${projectBase}\n`,
        );
      const hook = await renderUseRegistry();
      try {
        const snapshot = await hook.value.refresh();
        expect(snapshot?.[0]?.baseBranch).toBe(projectBase ?? "upstream/main");
      } finally {
        hook.unmount();
      }
    },
  );

  test("resolves null and keeps the previous repos when the load fails", async () => {
    registryFixtures.listRepos.mockResolvedValue([
      { id: RegistrationId("r1"), repo_path: repoPath, project: "alpha" },
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

  test("resolves null and keeps previous profiles when profile loading is aborted", async () => {
    writeFileSync(join(repoPath, ".wct.yaml"), "profiles:\n  local: {}\n");
    const hook = await renderUseRegistry();
    try {
      const loaded = await hook.value.refresh();
      expect(loaded?.[0]?.profileNames).toEqual(["local"]);

      const started = Promise.withResolvers<void>();
      const controller = new AbortController();
      runtimeFixtures.runPromise.mockImplementationOnce(
        (_effect: unknown, options?: { signal?: AbortSignal }) => {
          expect(options?.signal).toBeDefined();
          started.resolve();
          return Effect.runPromise(Effect.never, options);
        },
      );

      const refreshing = hook.value.refresh(controller.signal);
      await started.promise;
      controller.abort();

      expect(await refreshing).toBeNull();
      expect(hook.value.repos).toEqual(loaded);
    } finally {
      hook.unmount();
    }
  });

  test("does not publish a snapshot aborted after profile loading succeeds", async () => {
    const hook = await renderUseRegistry();
    try {
      const loaded = await hook.value.refresh();
      expect(loaded).toHaveLength(1);

      const controller = new AbortController();
      worktreeFixtures.listWorktrees.mockImplementationOnce(async () => {
        controller.abort();
        return [worktreeOf(repoPath, "other")];
      });

      expect(await hook.value.refresh(controller.signal)).toBeNull();
      expect(hook.value.repos).toEqual(loaded);
    } finally {
      hook.unmount();
    }
  });
});

test("shares four subprocess permits across overlapping scans and recovers after cancellation", async () => {
  const { measureObservationOverlap } =
    await import("../helpers/local-observation");
  const { provideBunServices } = await import("../../src/effect/runtime");
  const { Effect } = await import("effect");
  const measured = await Effect.runPromise(
    provideBunServices(Effect.scoped(measureObservationOverlap)),
  );
  expect(measured).toEqual({
    peak: 4,
    active: 0,
    startedBeforeCancellation: 4,
    repositories: 6,
    sessions: 12,
  });
});

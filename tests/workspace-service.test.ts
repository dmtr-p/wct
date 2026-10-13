import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runBunPromise } from "../src/effect/runtime";
import { commandError, WctCommandError } from "../src/errors";
import {
  type GitHubServiceImplementation as GitHubService,
  liveGitHubService,
} from "../src/services/github-service";
import {
  livePrCacheService,
  type PrCacheServiceApi,
} from "../src/services/pr-cache-service";
import { execProcess } from "../src/services/process";
import {
  liveSetupService,
  type SetupResult,
  type SetupService,
} from "../src/services/setup-service";
import type { TmuxService } from "../src/services/tmux";
import {
  liveWorkspaceService,
  type WorkspacePhase,
  type WorkspaceReporter,
  type WorkspaceReporterEvent,
  WorkspaceService,
} from "../src/services/workspace-service";
import {
  liveWorktreeService,
  type WorktreeServiceImplementation as WorktreeService,
} from "../src/services/worktree-service";
import {
  noopTmuxService,
  shutdownWorktreeService,
  withTestServices,
} from "./helpers/services";

async function writeConfig(repoDir: string, body = "") {
  await Bun.write(
    join(repoDir, ".wct.yaml"),
    `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
${body}`,
  );
}

async function prepareCopyRepo(repoDir: string) {
  await runBunPromise(
    execProcess("git", ["init", "--quiet", "--template=", repoDir]),
  );
  await Bun.write(join(repoDir, ".gitignore"), "*\n");
}

describe("WorkspaceService target resolution", () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/current-worktree");
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  test("resolves current directory, explicit path, and branch targets", async () => {
    const seenPaths: string[] = [];
    const worktree: WorktreeService = {
      ...shutdownWorktreeService,
      isGitRepo: (cwd) =>
        Effect.sync(() => {
          if (cwd) seenPaths.push(cwd);
          return true;
        }),
      findWorktreeByBranch: (branch) =>
        Effect.succeed(
          branch === "feature"
            ? {
                path: "/tmp/feature-worktree",
                branch,
                commit: "abc123",
                isBare: false,
              }
            : null,
        ),
    };

    const tmux: TmuxService = {
      ...noopTmuxService,
      sessionExists: () => Effect.succeed(false),
    };

    const current = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.down()),
        { tmux, worktree },
      ),
    );
    const explicit = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.down({ path: "/tmp/explicit-worktree" }),
        ),
        { tmux, worktree },
      ),
    );
    const branch = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.down({ branch: "feature" })),
        { tmux, worktree },
      ),
    );

    expect(current.worktreePath).toBe("/tmp/current-worktree");
    expect(explicit.worktreePath).toBe("/tmp/explicit-worktree");
    expect(branch.worktreePath).toBe("/tmp/feature-worktree");
    expect(seenPaths).toEqual([
      "/tmp/current-worktree",
      "/tmp/explicit-worktree",
      "/tmp/feature-worktree",
    ]);
  });

  test("rejects mutually exclusive path and branch targets", async () => {
    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.down({ path: "/tmp/a", branch: "feature" }),
          ),
        ),
      ),
    ).rejects.toThrow("--path and --branch are mutually exclusive");
  });

  test("up resolves branch targets through WorkspaceService", async () => {
    const mainRepoPath = await mkdtemp(join(tmpdir(), "wct-workspace-main-"));
    const worktree: WorktreeService = {
      ...liveWorktreeService,
      getWorktreeRoot: (cwd) => Effect.succeed(cwd),
      findWorktreeByBranch: (branch) =>
        Effect.succeed(
          branch === "feature"
            ? {
                path: "/tmp/feature-worktree",
                branch,
                commit: "abc123",
                isBare: false,
              }
            : null,
        ),
      isGitRepo: (cwd) => Effect.succeed(cwd === "/tmp/feature-worktree"),
      getMainRepoPath: () => Effect.succeed(mainRepoPath),
      getCurrentBranch: () => Effect.succeed("feature"),
    };

    try {
      await writeConfig(mainRepoPath);

      const result = await runBunPromise(
        withTestServices(
          WorkspaceService.use((service) => service.up({ branch: "feature" })),
          {
            worktree,
            tmux: {
              ...noopTmuxService,
              createSession: (name) =>
                Effect.succeed({
                  _tag: "Created" as const,
                  sessionName: name,
                }),
            },
          },
        ),
      );

      expect(result.worktreePath).toBe("/tmp/feature-worktree");
      expect(result.branch).toBe("feature");
    } finally {
      await rm(mainRepoPath, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceService open", () => {
  let repoDir: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "wct-workspace-open-repo-"));
    await prepareCopyRepo(repoDir);
    worktreeRoot = join(repoDir, "..", "worktrees");
    await mkdir(worktreeRoot, { recursive: true });
    await writeConfig(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  function makeWorktreeService(
    overrides: Partial<WorktreeService> = {},
  ): WorktreeService {
    return {
      ...liveWorktreeService,
      isGitRepo: () => Effect.succeed(true),
      getMainRepoPath: () => Effect.succeed(repoDir),
      branchExists: () => Effect.succeed(true),
      createWorktree: (path, branch, existing, base) =>
        Effect.succeed({
          _tag: "Created" as const,
          path,
          branch,
          existing,
          base,
        }),
      ...overrides,
    };
  }

  test("opens a branch workspace with base-config path", async () => {
    await writeConfig(
      repoDir,
      `profiles:
  prof:
    match: "*"
    copy: []
`,
    );
    const createCalls: unknown[] = [];
    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.open({
            branch: "feature",
            base: "main",
            cwd: repoDir,
            profile: "prof",
          }),
        ),
        {
          worktree: makeWorktreeService({
            createWorktree: (path, branch, existing, base, cwd) =>
              Effect.sync(() => {
                createCalls.push({ path, branch, existing, base, cwd });
                return { _tag: "Created" as const, path };
              }),
          }),
          tmux: {
            ...noopTmuxService,
            createSession: () =>
              Effect.succeed({ _tag: "Created", sessionName: "myapp-feature" }),
          },
        },
      ),
    );

    expect(result).toMatchObject({
      operation: "open",
      branch: "feature",
      projectName: "myapp",
      sessionName: "myapp-feature",
      created: true,
      profileName: "prof",
    });
    expect(result.env.WCT_PROJECT).toBe("myapp");
    expect(createCalls).toEqual([
      {
        path: join(worktreeRoot, "myapp-feature"),
        branch: "feature",
        existing: false,
        base: "main",
        cwd: repoDir,
      },
    ]);
  });

  test("keeps profile lifecycle overrides out of path naming", async () => {
    await writeConfig(
      repoDir,
      `profiles:
  prof:
    match: "*"
    copy:
      - profile.env
`,
    );
    await Bun.write(join(repoDir, "profile.env"), "PROFILE=1\n");

    const openResult = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.open({
            branch: "profiled",
            cwd: repoDir,
            profile: "prof",
          }),
        ),
        {
          worktree: makeWorktreeService(),
        },
      ),
    );
    const upResult = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.up({ path: openResult.worktreePath, profile: "prof" }),
        ),
        {
          worktree: {
            ...liveWorktreeService,
            getWorktreeRoot: (cwd) => Effect.succeed(cwd),
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(repoDir),
            getCurrentBranch: () => Effect.succeed("profiled"),
          },
        },
      ),
    );

    expect(openResult.worktreePath).toBe(join(worktreeRoot, "myapp-profiled"));
    expect(openResult.env.WCT_PROJECT).toBe("myapp");
    expect(openResult.attempts.copy).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(upResult.env.WCT_PROJECT).toBe("myapp");
  });

  test("resolves PR branches and adds fork remotes before creating the worktree", async () => {
    const calls: string[] = [];
    const github: GitHubService = {
      ...liveGitHubService,
      isGhInstalled: Effect.succeed(true),
      resolveBaseRepo: () => Effect.succeed("acme/wct"),
      resolvePr: () =>
        Effect.succeed({
          branch: "contrib-feature",
          prNumber: 42,
          isCrossRepository: true,
          headOwner: "alice",
          headRepo: "wct",
        }),
      findRemoteForRepo: () => Effect.succeed(null),
      addForkRemote: (remote) =>
        Effect.sync(() => {
          calls.push(`add:${remote}`);
        }),
      fetchBranch: (branch, remote) =>
        Effect.sync(() => {
          calls.push(`fetch:${remote}/${branch}`);
        }),
    };
    const worktree = makeWorktreeService({
      branchExists: (branch) =>
        Effect.sync(() => {
          calls.push(`exists:${branch}`);
          return branch === "alice/contrib-feature";
        }),
      createWorktree: (_path, branch, existing, base) =>
        Effect.sync(() => {
          calls.push(`create:${branch}:${existing}:${base}`);
          return { _tag: "Created" as const, path: "created" };
        }),
    });

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.open({ pr: "42", cwd: repoDir }),
        ),
        { github, worktree },
      ),
    );

    expect(result.branch).toBe("contrib-feature");
    expect(calls).toEqual([
      "add:alice",
      "fetch:alice/contrib-feature",
      "exists:contrib-feature",
      "exists:alice/contrib-feature",
      "create:contrib-feature:false:alice/contrib-feature",
    ]);
  });

  test("resolves PR URLs, reuses existing remotes, and opens existing local branches", async () => {
    const calls: string[] = [];
    const github: GitHubService = {
      ...liveGitHubService,
      isGhInstalled: Effect.succeed(true),
      resolveBaseRepo: () => Effect.succeed("acme/wct"),
      resolvePr: (prNumber) =>
        Effect.sync(() => {
          calls.push(`resolve:${prNumber}`);
          return {
            branch: "existing-local",
            prNumber,
            isCrossRepository: true,
            headOwner: "alice",
            headRepo: "wct",
          };
        }),
      findRemoteForRepo: () => Effect.succeed("alice-fork"),
      addForkRemote: () => Effect.die("existing remote should be reused"),
      fetchBranch: (branch, remote) =>
        Effect.sync(() => {
          calls.push(`fetch:${remote}/${branch}`);
        }),
    };
    const worktree = makeWorktreeService({
      branchExists: (branch) =>
        Effect.sync(() => {
          calls.push(`exists:${branch}`);
          return branch === "existing-local";
        }),
      createWorktree: (_path, branch, existing, base) =>
        Effect.sync(() => {
          calls.push(`create:${branch}:${existing}:${base ?? "none"}`);
          return { _tag: "Created" as const, path: "created" };
        }),
    });

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.open({
            pr: "https://github.com/acme/wct/pull/42",
            cwd: repoDir,
          }),
        ),
        { github, worktree },
      ),
    );

    expect(result.branch).toBe("existing-local");
    expect(calls).toEqual([
      "resolve:42",
      "fetch:alice-fork/existing-local",
      "exists:existing-local",
      "create:existing-local:true:none",
    ]);
  });

  test("handles same-repo PRs without adding fork remotes", async () => {
    const calls: string[] = [];
    const github: GitHubService = {
      ...liveGitHubService,
      isGhInstalled: Effect.succeed(true),
      resolveBaseRepo: () => Effect.succeed("acme/wct"),
      resolvePr: () =>
        Effect.succeed({
          branch: "same-repo",
          prNumber: 7,
          isCrossRepository: false,
        }),
      addForkRemote: () => Effect.die("same-repo PR should not add a remote"),
      fetchBranch: (branch, remote) =>
        Effect.sync(() => {
          calls.push(`fetch:${remote}/${branch}`);
        }),
    };
    const worktree = makeWorktreeService({
      branchExists: (branch) => Effect.succeed(branch === "origin/same-repo"),
      createWorktree: (_path, branch, existing, base) =>
        Effect.sync(() => {
          calls.push(`create:${branch}:${existing}:${base}`);
          return { _tag: "Created" as const, path: "created" };
        }),
    });

    await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.open({ pr: "7", cwd: repoDir }),
        ),
        { github, worktree },
      ),
    );

    expect(calls).toEqual([
      "fetch:origin/same-repo",
      "create:same-repo:false:origin/same-repo",
    ]);
  });

  for (const failedStep of [
    "repository lookup",
    "association write",
  ] as const) {
    test(`continues open after a failed PR ${failedStep}`, async () => {
      await writeConfig(
        repoDir,
        `copy:
  - .wct.yaml
setup:
  - name: install
    command: "true"
`,
      );
      const calls: string[] = [];
      const github: GitHubService = {
        ...liveGitHubService,
        isGhInstalled: Effect.succeed(true),
        resolvePr: () =>
          Effect.succeed({
            branch: "metadata-failure",
            prNumber: 42,
            isCrossRepository: false,
          }),
        fetchBranch: () => Effect.void,
        resolveBaseRepo: () =>
          failedStep === "repository lookup"
            ? Effect.fail(commandError("pr_error", "lookup failed"))
            : Effect.succeed("acme/wct"),
      };
      const prCache: PrCacheServiceApi = {
        ...livePrCacheService,
        setExplicit: () => {
          calls.push("associate");
          return Effect.fail(commandError("pr_error", "cache failed"));
        },
      };
      const setup: SetupService = {
        ...liveSetupService,
        runSetupCommands: () => {
          calls.push("setup");
          return Effect.succeed([{ name: "install", _tag: "Succeeded" }]);
        },
      };
      const tmux: TmuxService = {
        ...noopTmuxService,
        createSession: (name) => {
          calls.push("tmux");
          return Effect.succeed({ _tag: "Created", sessionName: name });
        },
      };

      const result = await runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.open({ pr: "42", cwd: repoDir }),
          ),
          { github, prCache, setup, tmux, worktree: makeWorktreeService() },
        ),
      );

      expect(result.operation).toBe("open");
      expect(result.attempts.copy).toMatchObject({ attempted: true, ok: true });
      expect(result.attempts.setup).toMatchObject({
        attempted: true,
        ok: true,
      });
      expect(result.attempts.tmux).toMatchObject({ attempted: true, ok: true });
      expect(calls).toEqual(
        failedStep === "repository lookup"
          ? ["setup", "tmux"]
          : ["associate", "setup", "tmux"],
      );
    });
  }

  test("surfaces PR setup failures from gh, remote add, and fetch", async () => {
    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.open({ pr: "1", cwd: repoDir }),
          ),
          {
            github: {
              ...liveGitHubService,
              isGhInstalled: Effect.succeed(false),
            },
          },
        ),
      ),
    ).rejects.toThrow("GitHub CLI (gh) is not installed");

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.open({ pr: "1", cwd: repoDir }),
          ),
          {
            github: {
              ...liveGitHubService,
              isGhInstalled: Effect.succeed(true),
              resolvePr: () =>
                Effect.succeed({
                  branch: "fork-fails",
                  prNumber: 1,
                  isCrossRepository: true,
                  headOwner: "alice",
                  headRepo: "wct",
                }),
              findRemoteForRepo: () => Effect.succeed(null),
              addForkRemote: () =>
                Effect.fail(commandError("pr_error", "remote add failed")),
            },
          },
        ),
      ),
    ).rejects.toThrow("remote add failed");

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.open({ pr: "1", cwd: repoDir }),
          ),
          {
            github: {
              ...liveGitHubService,
              isGhInstalled: Effect.succeed(true),
              resolvePr: () =>
                Effect.succeed({
                  branch: "fetch-fails",
                  prNumber: 1,
                  isCrossRepository: false,
                }),
              fetchBranch: () =>
                Effect.fail(commandError("pr_error", "fetch failed")),
            },
          },
        ),
      ),
    ).rejects.toThrow("fetch failed");
  });

  test("preserves resolvePr failure code and message", async () => {
    try {
      await runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.open({ pr: "123", cwd: repoDir }),
          ),
          {
            github: {
              ...liveGitHubService,
              isGhInstalled: Effect.succeed(true),
              resolvePr: () =>
                Effect.fail(
                  commandError("pr_error", "could not resolve PR 123"),
                ),
            },
          },
        ),
      );
      throw new Error("Expected PR resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WctCommandError);
      expect((error as WctCommandError).code).toBe("pr_error");
      expect((error as WctCommandError).message).toBe(
        "could not resolve PR 123",
      );
    }
  });

  test("treats path conflicts and copy failures as fatal", async () => {
    await writeConfig(repoDir, `copy:\n  - copy.env\n`);
    await Bun.write(join(repoDir, "copy.env"), "secret");
    for (const branch of ["copy-fails", "copy-fails-reporter"]) {
      await mkdir(join(worktreeRoot, `myapp-${branch}`, "copy.env"), {
        recursive: true,
      });
    }
    const copyEvents: WorkspaceReporterEvent[] = [];

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.open({ branch: "conflict", cwd: repoDir }),
          ),
          {
            worktree: makeWorktreeService({
              createWorktree: (path) =>
                Effect.succeed({
                  _tag: "PathConflict" as const,
                  path,
                  existingBranch: "other",
                }),
            }),
          },
        ),
      ),
    ).rejects.toThrow("Path already exists for branch 'other', not 'conflict'");

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.open({
              branch: "copy-fails",
              cwd: repoDir,
              reporter: {
                event: (event) =>
                  Effect.sync(() => {
                    copyEvents.push(event);
                  }),
              },
            }),
          ),
          { worktree: makeWorktreeService() },
        ),
      ),
    ).rejects.toThrow("Failed to copy files");

    expect(copyEvents).toContainEqual(
      expect.objectContaining({
        operation: "open",
        _tag: "CopyEntryFailed",
        file: "copy.env",
        reason: "copy_failed",
        error: expect.any(String),
      }),
    );

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.open({
              branch: "copy-fails-reporter",
              cwd: repoDir,
              reporter: {
                event: (event) =>
                  event._tag === "CopyEntryFailed"
                    ? Effect.fail(
                        commandError("unexpected_error", "reporter failed"),
                      )
                    : Effect.void,
              },
            }),
          ),
          { worktree: makeWorktreeService() },
        ),
      ),
    ).rejects.toThrow("Failed to copy files: copy.env:");
  });

  test("types optional setup failures as optional warnings", async () => {
    await writeConfig(
      repoDir,
      `setup:
  - name: optional-step
    command: "false"
    optional: true
`,
    );
    const setup: SetupService = {
      ...liveSetupService,
      runSetupCommands: () =>
        Effect.succeed([
          { _tag: "OptionalFailed", name: "optional-step", error: "skipped" },
        ] satisfies SetupResult[]),
    };

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.open({ branch: "optional-warning", cwd: repoDir }),
        ),
        {
          setup,
          worktree: makeWorktreeService(),
        },
      ),
    );

    expect(result.warnings).toContainEqual({
      _tag: "SetupFailed",
      operation: "open",
      name: "optional-step",
      optional: true,
      error: {
        code: "optional_setup_failed",
        message: "skipped",
      },
    });
  });
});

describe("WorkspaceService down", () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/myapp-feature");
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  test("kills an existing tmux session", async () => {
    const killCalls: string[] = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.down()),
        {
          worktree: {
            ...shutdownWorktreeService,
            isGitRepo: () => Effect.succeed(true),
          },
          tmux: {
            ...noopTmuxService,
            sessionExists: () => Effect.succeed(true),
            killSession: (name) =>
              Effect.sync(() => {
                killCalls.push(name);
              }),
          },
        },
      ),
    );

    expect(result).toEqual({
      operation: "down",
      worktreePath: "/tmp/myapp-feature",
      sessionName: "myapp-feature",
      existed: true,
      status: "killed",
      attempts: {
        down: { attempted: false as const, reason: "down_not_configured" },
        kill: {
          attempted: true,
          ok: true,
          value: null,
        },
      },
      warnings: [],
    });
    expect(killCalls).toEqual(["myapp-feature"]);
  });

  test("treats an absent session as informational success", async () => {
    const killCalls: string[] = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.down()),
        {
          worktree: {
            ...shutdownWorktreeService,
            isGitRepo: () => Effect.succeed(true),
          },
          tmux: {
            ...noopTmuxService,
            sessionExists: () => Effect.succeed(false),
            killSession: (name) =>
              Effect.sync(() => {
                killCalls.push(name);
              }),
          },
        },
      ),
    );

    expect(result.status).toBe("absent");
    expect(result.attempts.kill).toEqual({
      attempted: false,
      reason: "session_absent",
    });
    expect(result.warnings).toEqual([]);
    expect(killCalls).toEqual([]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("fails when branch target cannot be resolved", async () => {
    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.down({ branch: "missing-branch" }),
          ),
          {
            worktree: {
              ...shutdownWorktreeService,
              findWorktreeByBranch: () => Effect.succeed(null),
            },
          },
        ),
      ),
    ).rejects.toThrow("No worktree found for branch 'missing-branch'");
  });

  test("treats tmux kill failure as fatal", async () => {
    const tmux: TmuxService = {
      ...noopTmuxService,
      sessionExists: () => Effect.succeed(true),
      killSession: () => Effect.fail(commandError("tmux_error", "kill boom")),
    };

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) => service.down()),
          {
            worktree: {
              ...shutdownWorktreeService,
              isGitRepo: () => Effect.succeed(true),
            },
            tmux,
          },
        ),
      ),
    ).rejects.toThrow("kill boom");
  });
});

describe("WorkspaceService close", () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/myapp-feature");
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  test("continues to removal when tmux session is absent", async () => {
    const removeCalls: Array<{ path: string; force?: boolean }> = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.close()),
        {
          worktree: {
            ...shutdownWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            removeWorktree: (path, force) =>
              Effect.sync(() => {
                removeCalls.push({ path, force });
                return { _tag: "Removed" as const, path };
              }),
          },
          tmux: {
            ...noopTmuxService,
            sessionExists: () => Effect.succeed(false),
            killSession: () => Effect.die("kill should not be called"),
          },
        },
      ),
    );

    expect(result).toEqual({
      operation: "close",
      worktreePath: "/tmp/myapp-feature",
      sessionName: "myapp-feature",
      existed: false,
      status: "removed",
      attempts: {
        down: { attempted: false as const, reason: "down_not_configured" },
        kill: {
          attempted: false,
          reason: "session_absent",
        },
        remove: {
          attempted: true,
          ok: true,
          value: { _tag: "Removed", path: "/tmp/myapp-feature" },
        },
      },
      warnings: [],
    });
    expect(removeCalls).toEqual([{ path: "/tmp/myapp-feature", force: false }]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("kills tmux before attempting worktree removal", async () => {
    const calls: string[] = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.close({ branch: "feature" })),
        {
          worktree: {
            ...shutdownWorktreeService,
            findWorktreeByBranch: (branch) =>
              Effect.succeed({
                path: `/tmp/myapp-${branch}`,
                branch,
                commit: "abc123",
                isBare: false,
              }),
            isGitRepo: () => Effect.succeed(true),
            removeWorktree: (path) =>
              Effect.sync(() => {
                calls.push(`remove:${path}`);
                return { _tag: "Removed" as const, path };
              }),
          },
          tmux: {
            ...noopTmuxService,
            sessionExists: () => Effect.succeed(true),
            killSession: (name) =>
              Effect.sync(() => {
                calls.push(`kill:${name}`);
              }),
          },
        },
      ),
    );

    expect(result.status).toBe("removed");
    expect(result.sessionName).toBe("myapp-feature");
    expect(calls).toEqual(["kill:myapp-feature", "remove:/tmp/myapp-feature"]);
  });

  test("resolves a relative branch path before closing a missing worktree", async () => {
    const relativePath = "deleted-feature";
    const absolutePath = resolve(relativePath);
    const removeCalls: string[] = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.close({ branch: "feature", cwd: "/repos/myapp" }),
        ),
        {
          worktree: {
            ...shutdownWorktreeService,
            findWorktreeByBranch: (branch) =>
              Effect.succeed({
                path: relativePath,
                branch,
                commit: "abc123",
                isBare: false,
              }),
            isGitRepo: () => Effect.succeed(false),
            listWorktrees: () =>
              Effect.succeed([
                {
                  path: relativePath,
                  branch: "feature",
                  commit: "abc123",
                  isBare: false,
                },
              ]),
            removeWorktree: (path) =>
              Effect.sync(() => {
                removeCalls.push(path);
                return { _tag: "Removed" as const, path };
              }),
          },
          tmux: {
            ...noopTmuxService,
            sessionExists: () => Effect.succeed(false),
          },
        },
      ),
    );

    expect(result.worktreePath).toBe(absolutePath);
    expect(result.status).toBe("removed");
    expect(removeCalls).toEqual([absolutePath]);
  });

  test("resolves explicit path targets", async () => {
    const seenPaths: string[] = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.close({ path: "/tmp/myapp-explicit" }),
        ),
        {
          worktree: {
            ...shutdownWorktreeService,
            isGitRepo: (cwd) =>
              Effect.sync(() => {
                if (cwd) seenPaths.push(cwd);
                return true;
              }),
            removeWorktree: (path) =>
              Effect.succeed({ _tag: "Removed" as const, path }),
          },
          tmux: {
            ...noopTmuxService,
            sessionExists: () => Effect.succeed(false),
          },
        },
      ),
    );

    expect(result.worktreePath).toBe("/tmp/myapp-explicit");
    expect(result.sessionName).toBe("myapp-explicit");
    expect(result.attempts.remove).toEqual({
      attempted: true,
      ok: true,
      value: { _tag: "Removed", path: "/tmp/myapp-explicit" },
    });
    expect(seenPaths).toEqual(["/tmp/myapp-explicit"]);
  });

  test("kill failure is fatal and prevents removal", async () => {
    const removeCalls: string[] = [];

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) => service.close()),
          {
            worktree: {
              ...shutdownWorktreeService,
              isGitRepo: () => Effect.succeed(true),
              removeWorktree: (path) =>
                Effect.sync(() => {
                  removeCalls.push(path);
                  return { _tag: "Removed" as const, path };
                }),
            },
            tmux: {
              ...noopTmuxService,
              sessionExists: () => Effect.succeed(true),
              killSession: () =>
                Effect.fail(commandError("tmux_error", "kill boom")),
            },
          },
        ),
      ),
    ).rejects.toThrow("kill boom");
    expect(removeCalls).toEqual([]);
  });

  test("returns a structured blocked-by-changes result", async () => {
    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.close()),
        {
          worktree: {
            ...shutdownWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            removeWorktree: (path) =>
              Effect.succeed({ _tag: "BlockedByChanges" as const, path }),
          },
          tmux: {
            ...noopTmuxService,
            sessionExists: () => Effect.succeed(false),
          },
        },
      ),
    );

    expect(result.status).toBe("blocked_by_changes");
    expect(result.attempts.remove).toEqual({
      attempted: true,
      ok: true,
      value: { _tag: "BlockedByChanges", path: "/tmp/myapp-feature" },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("passes force to worktree removal", async () => {
    const forceArgs: Array<boolean | undefined> = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.close({ force: true })),
        {
          worktree: {
            ...shutdownWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            removeWorktree: (path, force) =>
              Effect.sync(() => {
                forceArgs.push(force);
                return { _tag: "Removed" as const, path };
              }),
          },
          tmux: {
            ...noopTmuxService,
            sessionExists: () => Effect.succeed(false),
          },
        },
      ),
    );

    expect(result.status).toBe("removed");
    expect(forceArgs).toEqual([true]);
  });

  test("passes explicit cwd to worktree removal", async () => {
    const removeCalls: Array<{
      path: string;
      force?: boolean;
      cwd?: string;
    }> = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.close({
            path: "/tmp/myapp-feature",
            cwd: "/repos/myapp",
          }),
        ),
        {
          worktree: {
            ...shutdownWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            removeWorktree: (path, force, cwd) =>
              Effect.sync(() => {
                removeCalls.push({ path, force, cwd });
                return { _tag: "Removed" as const, path };
              }),
          },
          tmux: {
            ...noopTmuxService,
            sessionExists: () => Effect.succeed(false),
          },
        },
      ),
    );

    expect(result.status).toBe("removed");
    expect(removeCalls).toEqual([
      { path: "/tmp/myapp-feature", force: false, cwd: "/repos/myapp" },
    ]);
  });
});

describe("WorkspaceService reporter", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "wct-workspace-reporter-repo-"));
    await writeConfig(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  test("emits typed events in order and swallows reporter failures", async () => {
    const events: WorkspaceReporterEvent[] = [];
    const reporter = {
      event: (event: WorkspaceReporterEvent) =>
        Effect.sync(() => {
          events.push(event);
          if (event._tag === "TargetResolved") {
            throw new Error("reporter failed");
          }
        }),
    };

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.down({ path: "/tmp/myapp-feature", reporter }),
          ),
          {
            worktree: {
              ...shutdownWorktreeService,
              isGitRepo: () => Effect.succeed(true),
            },
            tmux: {
              ...noopTmuxService,
              sessionExists: () => Effect.succeed(false),
            },
          },
        ),
      ),
    ).resolves.toMatchObject({ status: "absent" });

    expect(events).toEqual([
      {
        operation: "down",
        _tag: "PhaseStarted",
        phase: { _tag: "Preparing" },
      },
      {
        operation: "down",
        _tag: "TargetResolved",
        worktreePath: "/tmp/myapp-feature",
      },
      {
        operation: "down",
        _tag: "SessionAbsent",
        sessionName: "myapp-feature",
      },
    ]);
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  });

  test("swallows reporters that throw before returning an Effect", async () => {
    const reporter = {
      event: (_event: WorkspaceReporterEvent) => {
        throw new Error("reporter construction failed");
      },
    };

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.down({ path: "/tmp/myapp-feature", reporter }),
          ),
          {
            worktree: {
              ...shutdownWorktreeService,
              isGitRepo: () => Effect.succeed(true),
            },
            tmux: {
              ...noopTmuxService,
              sessionExists: () => Effect.succeed(false),
            },
          },
        ),
      ),
    ).resolves.toMatchObject({ status: "absent" });
  });
});

test("liveWorkspaceService exposes public lifecycle operations", () => {
  expect(typeof liveWorkspaceService.open).toBe("function");
  expect(typeof liveWorkspaceService.up).toBe("function");
  expect(typeof liveWorkspaceService.down).toBe("function");
  expect(typeof liveWorkspaceService.close).toBe("function");
  expect(typeof liveWorkspaceService.retryCloseRemoval).toBe("function");
});

describe("WorkspaceService semantic phases", () => {
  let parentDir: string;
  let repoDir: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    parentDir = await mkdtemp(join(tmpdir(), "wct-workspace-phase-"));
    repoDir = join(parentDir, "repo");
    worktreeRoot = join(parentDir, "worktrees");
    await mkdir(repoDir, { recursive: true });
    await prepareCopyRepo(repoDir);
    await mkdir(worktreeRoot, { recursive: true });
    await writeConfig(repoDir);
  });

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true });
  });

  function recordingReporter(events: WorkspaceReporterEvent[]) {
    return {
      event: (event: WorkspaceReporterEvent) =>
        Effect.sync(() => {
          events.push(event);
        }),
    };
  }

  function phasesOf(events: WorkspaceReporterEvent[]): WorkspacePhase[] {
    return events.flatMap((event) =>
      event._tag === "PhaseStarted" ? [event.phase] : [],
    );
  }

  function openWorktreeService(
    overrides: Partial<WorktreeService> = {},
  ): WorktreeService {
    return {
      ...liveWorktreeService,
      isGitRepo: () => Effect.succeed(true),
      getMainRepoPath: () => Effect.succeed(repoDir),
      branchExists: () => Effect.succeed(true),
      createWorktree: (path) =>
        Effect.succeed({ _tag: "Created" as const, path }),
      ...overrides,
    };
  }

  test.each(["open", "up"] as const)(
    "%s preserves tmux attempts, reporter order, and startup arguments",
    async (operation) => {
      await writeConfig(
        repoDir,
        `work_dir: "app"
setup:
  - name: bootstrap
    command: "true"
profiles:
  dev:
    tmux:
      windows:
        - name: dev
`,
      );
      const branch = "feature";
      const worktreePath = join(worktreeRoot, "myapp-feature");
      await mkdir(join(worktreePath, "app"), { recursive: true });
      const worktree = openWorktreeService({
        getWorktreeRoot: () => Effect.succeed(worktreePath),
        getCurrentBranch: () => Effect.succeed(branch),
      });
      for (const outcome of [
        "Created",
        "AlreadyExists",
        "failed",
        "unconfigured",
      ] as const) {
        if (outcome === "unconfigured") {
          await Bun.write(
            join(repoDir, ".wct.yaml"),
            `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
`,
          );
        }
        const events: WorkspaceReporterEvent[] = [];
        const createSession = vi.fn<TmuxService["createSession"]>(
          (sessionName) => {
            expect(events.slice(-2)).toEqual([
              {
                operation,
                _tag: "PhaseStarted",
                phase: { _tag: "StartingTmuxSession" },
              },
              { operation, _tag: "AttemptStarted", attempt: "tmux" },
            ]);
            if (operation === "open") {
              expect(events).toContainEqual({
                operation,
                _tag: "AttemptCompleted",
                attempt: "setup",
                ok: true,
              });
            } else {
              expect(
                events.some(
                  (event) =>
                    event._tag === "AttemptStarted" &&
                    event.attempt === "setup",
                ),
              ).toBe(false);
            }
            return outcome === "failed"
              ? Effect.fail(commandError("tmux_error", "startup failed"))
              : Effect.succeed({
                  _tag:
                    outcome === "AlreadyExists" ? "AlreadyExists" : "Created",
                  sessionName,
                });
          },
        );
        const reporter = recordingReporter(events);
        const profile = outcome === "unconfigured" ? undefined : "dev";
        const result = await runBunPromise(
          withTestServices(
            WorkspaceService.use((service) =>
              operation === "open"
                ? service.open({ branch, cwd: repoDir, profile, reporter })
                : service.up({ path: worktreePath, profile, reporter }),
            ),
            { worktree, tmux: { ...noopTmuxService, createSession } },
          ),
        );
        if (outcome === "unconfigured") {
          expect(createSession).not.toHaveBeenCalled();
          expect(result.attempts.tmux).toEqual({
            attempted: false,
            reason: "tmux_not_configured",
          });
          expect(
            events.some(
              (event) =>
                event._tag === "PhaseStarted" &&
                event.phase._tag === "StartingTmuxSession",
            ),
          ).toBe(false);
          expect(
            events.some(
              (event) =>
                (event._tag === "AttemptStarted" ||
                  event._tag === "AttemptCompleted") &&
                event.attempt === "tmux",
            ),
          ).toBe(false);
          expect(result.warnings).toEqual([]);
        } else {
          expect(createSession).toHaveBeenCalledExactlyOnceWith(
            "myapp-feature",
            join(worktreePath, "app"),
            { windows: [{ name: "dev" }] },
            result.env,
          );
          expect(result.env).toMatchObject({
            WCT_BRANCH: branch,
            WCT_MAIN_DIR: repoDir,
            WCT_WORK_DIR: join(worktreePath, "app"),
          });
          expect(events.at(-1)).toEqual({
            operation,
            _tag: "AttemptCompleted",
            attempt: "tmux",
            ok: outcome !== "failed",
          });
          if (outcome === "failed") {
            const error = { code: "tmux_error", message: "startup failed" };
            expect(result.attempts.tmux).toEqual({
              attempted: true,
              ok: false,
              error,
            });
            expect(result.warnings).toEqual([
              { _tag: "TmuxStartFailed", operation, error },
            ]);
          } else {
            expect(result.attempts.tmux).toEqual({
              attempted: true,
              ok: true,
              value: { _tag: outcome, sessionName: "myapp-feature" },
            });
            expect(result.warnings).toEqual([]);
          }
        }
      }
    },
  );

  test("open emits preparing first, then a phase per attempted step in execution order", async () => {
    await writeConfig(
      repoDir,
      `copy:
  - .wct.yaml
  - "**/*.missing"
setup:
  - name: install
    command: "false"
    optional: true
  - name: build
    command: "true"
`,
    );
    const events: WorkspaceReporterEvent[] = [];

    await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.open({
            branch: "phases",
            cwd: repoDir,
            reporter: recordingReporter(events),
          }),
        ),
        { worktree: openWorktreeService() },
      ),
    );

    expect(phasesOf(events)).toEqual([
      { _tag: "Preparing" },
      { _tag: "CreatingWorktree" },
      { _tag: "CopyingFiles" },
      { _tag: "RunningSetup", name: "install" },
      { _tag: "RunningSetup", name: "build" },
      { _tag: "StartingTmuxSession" },
    ]);
    expect(events[0]).toEqual({
      operation: "open",
      _tag: "PhaseStarted",
      phase: { _tag: "Preparing" },
    });
    type SetupProgressEvent =
      | Extract<
          WorkspaceReporterEvent,
          { _tag: "CopyEntrySkipped" | "SetupCommandStarted" }
        >
      | {
          operation: "open";
          _tag: "SetupCommandCompleted";
          result: Pick<SetupResult, "name" | "_tag">;
        };
    const setupProgressEvents = events
      .filter(
        (
          event,
        ): event is Extract<
          WorkspaceReporterEvent,
          {
            _tag:
              | "CopyEntrySkipped"
              | "SetupCommandStarted"
              | "SetupCommandCompleted";
          }
        > =>
          event._tag === "CopyEntrySkipped" ||
          event._tag === "SetupCommandStarted" ||
          event._tag === "SetupCommandCompleted",
      )
      .map<SetupProgressEvent>((event) =>
        event._tag === "SetupCommandCompleted"
          ? {
              ...event,
              result: { name: event.result.name, _tag: event.result._tag },
            }
          : event,
      );

    expect(setupProgressEvents).toEqual([
      {
        operation: "open",
        _tag: "CopyEntrySkipped",
        entry: "**/*.missing",
        reason: "glob_no_matches",
      },
      {
        operation: "open",
        _tag: "SetupCommandStarted",
        name: "install",
        current: 1,
        total: 2,
      },
      {
        operation: "open",
        _tag: "SetupCommandCompleted",
        result: {
          name: "install",
          _tag: "OptionalFailed",
        },
      },
      {
        operation: "open",
        _tag: "SetupCommandStarted",
        name: "build",
        current: 2,
        total: 2,
      },
      {
        operation: "open",
        _tag: "SetupCommandCompleted",
        result: {
          name: "build",
          _tag: "Succeeded",
        },
      },
    ]);

    await Bun.write(
      join(repoDir, ".wct.yaml"),
      `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
`,
    );
    const bare: WorkspaceReporterEvent[] = [];
    await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.open({
            branch: "phases-bare",
            cwd: repoDir,
            reporter: recordingReporter(bare),
          }),
        ),
        { worktree: openWorktreeService() },
      ),
    );

    expect(phasesOf(bare)).toEqual([
      { _tag: "Preparing" },
      { _tag: "CreatingWorktree" },
    ]);
  });

  test("up emits preparing first and a tmux phase only when tmux is configured", async () => {
    const worktree: WorktreeService = {
      ...shutdownWorktreeService,
      isGitRepo: () => Effect.succeed(true),
      getMainRepoPath: () => Effect.succeed(repoDir),
      getCurrentBranch: () => Effect.succeed("feature"),
    };

    const withTmux: WorkspaceReporterEvent[] = [];
    await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.up({
            path: join(worktreeRoot, "myapp-feature"),
            reporter: recordingReporter(withTmux),
          }),
        ),
        { worktree },
      ),
    );
    expect(phasesOf(withTmux)).toEqual([
      { _tag: "Preparing" },
      { _tag: "StartingTmuxSession" },
    ]);
    expect(withTmux[0]?._tag).toBe("PhaseStarted");

    await Bun.write(
      join(repoDir, ".wct.yaml"),
      `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
`,
    );
    const withoutTmux: WorkspaceReporterEvent[] = [];
    await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.up({
            path: join(worktreeRoot, "myapp-feature"),
            reporter: recordingReporter(withoutTmux),
          }),
        ),
        { worktree },
      ),
    );
    expect(phasesOf(withoutTmux)).toEqual([{ _tag: "Preparing" }]);
  });

  test("down and close emit the stop phase before killSession, and only when a session exists", async () => {
    const worktree: WorktreeService = {
      ...shutdownWorktreeService,
      isGitRepo: () => Effect.succeed(true),
      removeWorktree: (path) =>
        Effect.succeed({ _tag: "Removed" as const, path }),
    };

    const runOperation = async (
      operation: "down" | "close",
      sessionExists: boolean,
      trace: string[],
    ): Promise<void> => {
      const reporter = {
        event: (event: WorkspaceReporterEvent) =>
          Effect.sync(() => {
            if (event._tag === "PhaseStarted") {
              trace.push(`phase:${event.phase._tag}`);
            }
          }),
      };
      const overrides = {
        worktree,
        tmux: {
          ...noopTmuxService,
          sessionExists: () => Effect.succeed(sessionExists),
          killSession: () =>
            Effect.sync(() => {
              trace.push("call:killSession");
            }),
        },
      };
      if (operation === "down") {
        await runBunPromise(
          withTestServices(
            WorkspaceService.use((service) =>
              service.down({ path: "/tmp/myapp-feature", reporter }),
            ),
            overrides,
          ),
        );
        return;
      }
      await runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.close({ path: "/tmp/myapp-feature", reporter }),
          ),
          overrides,
        ),
      );
    };

    for (const operation of ["down", "close"] as const) {
      const trace: string[] = [];
      await runOperation(operation, true, trace);

      expect(trace[0]).toBe("phase:Preparing");
      const stopPhaseIndex = trace.indexOf("phase:StoppingTmuxSession");
      const killCallIndex = trace.indexOf("call:killSession");
      expect(stopPhaseIndex).toBeGreaterThan(-1);
      expect(killCallIndex).toBeGreaterThan(stopPhaseIndex);

      const absentTrace: string[] = [];
      await runOperation(operation, false, absentTrace);
      expect(absentTrace[0]).toBe("phase:Preparing");
      expect(absentTrace).not.toContain("phase:StoppingTmuxSession");
      expect(absentTrace).not.toContain("call:killSession");
    }
  });

  test("close emits the worktree-removal phase before removeWorktree runs", async () => {
    const trace: string[] = [];
    const reporter = {
      event: (event: WorkspaceReporterEvent) =>
        Effect.sync(() => {
          if (event._tag === "PhaseStarted") {
            trace.push(`phase:${event.phase._tag}`);
          }
        }),
    };

    await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.close({ path: "/tmp/myapp-feature", reporter }),
        ),
        {
          worktree: {
            ...shutdownWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            removeWorktree: (path) =>
              Effect.sync(() => {
                trace.push("call:removeWorktree");
                return { _tag: "Removed" as const, path };
              }),
          },
          tmux: {
            ...noopTmuxService,
            sessionExists: () => Effect.succeed(false),
          },
        },
      ),
    );

    const removePhaseIndex = trace.indexOf("phase:RemovingWorktree");
    const removeCallIndex = trace.indexOf("call:removeWorktree");
    expect(removePhaseIndex).toBeGreaterThan(-1);
    expect(removeCallIndex).toBe(removePhaseIndex + 1);
  });

  test("reporter failures, defects, and synchronous throws cannot fail or change an open", async () => {
    await writeConfig(
      repoDir,
      `copy:
  - .wct.yaml
setup:
  - name: install
    command: "true"
`,
    );

    const runOpen = (
      reporter?: WorkspaceReporter,
      branch = "reporter-isolation",
    ) =>
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.open({
              branch,
              cwd: repoDir,
              ...(reporter ? { reporter } : {}),
            }),
          ),
          { worktree: openWorktreeService() },
        ),
      );

    const baseline = await runOpen(undefined, "reporter-baseline");

    const failing = await runOpen({
      event: () =>
        Effect.fail(commandError("unexpected_error", "reporter failed")),
    });
    const defective = await runOpen(
      { event: () => Effect.die(new Error("reporter defect")) },
      "reporter-defect",
    );
    const throwing = await runOpen(
      {
        event: () => {
          throw new Error("reporter construction failed");
        },
      },
      "reporter-throwing",
    );

    for (const result of [failing, defective, throwing]) {
      expect(result.operation).toBe("open");
      expect(result.warnings).toEqual(baseline.warnings);
      expect(result.attempts.copy.attempted).toBe(
        baseline.attempts.copy.attempted,
      );
      expect(result.attempts.setup).toEqual(baseline.attempts.setup);
      expect(result.attempts.tmux.attempted).toBe(
        baseline.attempts.tmux.attempted,
      );
    }
  });
});

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runBunPromise } from "../src/effect/runtime";
import { commandError, WctCommandError } from "../src/errors";
import {
  type GitHubService,
  liveGitHubService,
} from "../src/services/github-service";
import { type IdeService, liveIdeService } from "../src/services/ide-service";
import {
  liveSetupService,
  type SetupResult,
  type SetupService,
} from "../src/services/setup-service";
import { liveTmuxService, type TmuxService } from "../src/services/tmux";
import {
  liveVSCodeWorkspaceService,
  type VSCodeWorkspaceService,
} from "../src/services/vscode-workspace";
import {
  liveWorkspaceService,
  type WorkspaceReporterEvent,
  WorkspaceService,
} from "../src/services/workspace-service";
import {
  liveWorktreeService,
  type WorktreeService,
} from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

async function writeConfig(repoDir: string, body = "") {
  await Bun.write(
    join(repoDir, ".wct.yaml"),
    `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
ide:
  command: "echo ide"
${body}`,
  );
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
      ...liveWorktreeService,
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
      ...liveTmuxService,
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
              ...liveTmuxService,
              createSession: (name) =>
                Effect.succeed({
                  _tag: "Created" as const,
                  sessionName: name,
                }),
            },
            ide: {
              openIDE: () => Effect.succeed(undefined),
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
    worktreeRoot = join(repoDir, "..", "worktrees");
    await mkdir(worktreeRoot, { recursive: true });
    await writeConfig(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  function openWorktreeService(
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

  test("opens a branch workspace with base-config path and WCT_PROMPT", async () => {
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
            prompt: "ship it",
            profile: "prof",
          }),
        ),
        {
          worktree: openWorktreeService({
            createWorktree: (path, branch, existing, base, cwd) =>
              Effect.sync(() => {
                createCalls.push({ path, branch, existing, base, cwd });
                return { _tag: "Created" as const, path };
              }),
          }),
          tmux: {
            ...liveTmuxService,
            createSession: () =>
              Effect.succeed({ _tag: "Created", sessionName: "myapp-feature" }),
          },
          ide: {
            ...liveIdeService,
            openIDE: () => Effect.void,
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
    expect(result.env.WCT_PROMPT).toBe("ship it");
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

  test("keeps WCT_PROMPT open-only and profile lifecycle overrides out of path naming", async () => {
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
            prompt: "open prompt",
            profile: "prof",
          }),
        ),
        {
          worktree: openWorktreeService(),
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
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(repoDir),
            getCurrentBranch: () => Effect.succeed("profiled"),
          },
        },
      ),
    );

    expect(openResult.worktreePath).toBe(join(worktreeRoot, "myapp-profiled"));
    expect(openResult.env.WCT_PROJECT).toBe("myapp");
    expect(openResult.env.WCT_PROMPT).toBe("open prompt");
    expect(openResult.attempts.copy).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(upResult.env).not.toHaveProperty("WCT_PROMPT");
    expect(upResult.env.WCT_PROJECT).toBe("myapp");
  });

  test("resolves PR branches and adds fork remotes before creating the worktree", async () => {
    const calls: string[] = [];
    const github: GitHubService = {
      ...liveGitHubService,
      isGhInstalled: () => Effect.succeed(true),
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
    const worktree = openWorktreeService({
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
          service.open({ pr: "42", cwd: repoDir, noIde: true }),
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
      isGhInstalled: () => Effect.succeed(true),
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
    const worktree = openWorktreeService({
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
            noIde: true,
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
      isGhInstalled: () => Effect.succeed(true),
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
    const worktree = openWorktreeService({
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
          service.open({ pr: "7", cwd: repoDir, noIde: true }),
        ),
        { github, worktree },
      ),
    );

    expect(calls).toEqual([
      "fetch:origin/same-repo",
      "create:same-repo:false:origin/same-repo",
    ]);
  });

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
              isGhInstalled: () => Effect.succeed(false),
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
              isGhInstalled: () => Effect.succeed(true),
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
              isGhInstalled: () => Effect.succeed(true),
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
              isGhInstalled: () => Effect.succeed(true),
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
    await writeConfig(repoDir, `copy:\n  - missing.env\n`);

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.open({ branch: "conflict", cwd: repoDir }),
          ),
          {
            worktree: openWorktreeService({
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
            service.open({ branch: "copy-fails", cwd: repoDir }),
          ),
          { worktree: openWorktreeService() },
        ),
      ),
    ).rejects.toThrow("Failed to copy files");
  });

  test("runs copy, setup, and VS Code sync when the worktree already exists", async () => {
    await writeConfig(
      repoDir,
      `copy:
  - existing.env
setup:
  - name: bootstrap
    command: "echo setup"
ide:
  name: vscode
  command: "code"
  fork_workspace: true
`,
    );
    await Bun.write(join(repoDir, "existing.env"), "EXISTING=1\n");
    const calls: string[] = [];
    const setup: SetupService = {
      ...liveSetupService,
      runSetupCommands: () =>
        Effect.sync(() => {
          calls.push("setup");
          return [{ _tag: "Succeeded", name: "bootstrap" }];
        }),
    };
    const vscodeWorkspace: VSCodeWorkspaceService = {
      ...liveVSCodeWorkspaceService,
      syncWorkspaceState: () =>
        Effect.sync(() => {
          calls.push("vscode");
          return { success: true, skipped: true };
        }),
    };
    const worktree = openWorktreeService({
      createWorktree: (path) =>
        Effect.sync(() => {
          calls.push("worktree");
          return { _tag: "AlreadyExists" as const, path };
        }),
    });

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.open({ branch: "already", cwd: repoDir, ide: true }),
        ),
        {
          ide: {
            ...liveIdeService,
            openIDE: () => Effect.void,
          },
          setup,
          vscodeWorkspace,
          worktree,
        },
      ),
    );

    expect(result.created).toBe(false);
    expect(result.attempts.copy).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result.attempts.setup).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result.attempts.vscode).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(calls).toEqual(["worktree", "vscode", "setup"]);
  });

  test("returns typed warnings for setup, VS Code, tmux, and IDE failures", async () => {
    await writeConfig(
      repoDir,
      `setup:
  - name: required
    command: "false"
ide:
  name: vscode
  command: "code"
  fork_workspace: true
tmux: {}
`,
    );
    const setup: SetupService = {
      ...liveSetupService,
      runSetupCommands: () =>
        Effect.succeed([
          { _tag: "Failed", name: "required", error: "boom" },
        ] satisfies SetupResult[]),
    };
    const vscodeWorkspace: VSCodeWorkspaceService = {
      ...liveVSCodeWorkspaceService,
      syncWorkspaceState: () =>
        Effect.succeed({ success: false, error: "state unavailable" }),
    };
    const tmux: TmuxService = {
      ...liveTmuxService,
      createSession: () => Effect.fail(commandError("tmux_error", "no tmux")),
    };
    const ide: IdeService = {
      ...liveIdeService,
      openIDE: () => Effect.fail(commandError("unexpected_error", "no ide")),
    };

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.open({ branch: "warnings", cwd: repoDir }),
        ),
        {
          ide,
          setup,
          tmux,
          vscodeWorkspace,
          worktree: openWorktreeService(),
        },
      ),
    );

    expect(result.warnings.map((warning) => warning._tag)).toEqual([
      "VSCodeSyncFailed",
      "SetupFailed",
      "TmuxStartFailed",
      "IdeOpenFailed",
    ]);
    expect(result.attempts.tmux).toMatchObject({
      attempted: true,
      ok: false,
    });
    expect(result.attempts.ide).toMatchObject({ attempted: true, ok: false });
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
          worktree: openWorktreeService(),
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

  test("starts open tmux and IDE in parallel after prerequisite work", async () => {
    await writeConfig(repoDir, `tmux: {}\nide:\n  command: "code"\n`);
    const calls: string[] = [];
    let ideStarted = false;

    const result = await Promise.race([
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.open({ branch: "parallel", cwd: repoDir }),
          ),
          {
            worktree: openWorktreeService({
              createWorktree: (path) =>
                Effect.sync(() => {
                  calls.push("worktree");
                  return { _tag: "Created" as const, path };
                }),
            }),
            tmux: {
              ...liveTmuxService,
              createSession: (name) =>
                Effect.promise(async () => {
                  calls.push("tmux-started");
                  while (!ideStarted) {
                    await Bun.sleep(1);
                  }
                  calls.push("tmux-completed");
                  return { _tag: "Created" as const, sessionName: name };
                }),
            },
            ide: {
              ...liveIdeService,
              openIDE: () =>
                Effect.promise(async () => {
                  calls.push("ide-started");
                  ideStarted = true;
                  await Bun.sleep(1);
                  calls.push("ide-completed");
                }),
            },
          },
        ),
      ),
      Bun.sleep(100).then(() => {
        throw new Error(
          "workspace open did not start tmux and IDE in parallel",
        );
      }),
    ]);

    expect(result.attempts.tmux).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result.attempts.ide).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(calls).toEqual([
      "worktree",
      "tmux-started",
      "ide-started",
      "tmux-completed",
      "ide-completed",
    ]);
  });
});

describe("WorkspaceService up", () => {
  let repoDir: string;
  let worktreeRoot: string;
  let worktreePath: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "wct-workspace-repo-"));
    worktreeRoot = await mkdtemp(join(tmpdir(), "wct-workspace-wt-"));
    worktreePath = join(worktreeRoot, "myapp-feature");
    await writeConfig(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  test("starts tmux and IDE without running copy or setup", async () => {
    const calls: string[] = [];
    const sourceFile = join(repoDir, ".env.local");
    const copiedFile = join(worktreePath, ".env.local");
    await mkdir(worktreePath, { recursive: true });
    await Bun.write(sourceFile, "SECRET=1\n");
    await writeConfig(
      repoDir,
      `copy:
  - ".env.local"
`,
    );

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.up({ path: worktreePath })),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: (cwd) => Effect.succeed(cwd === worktreePath),
            getMainRepoPath: () => Effect.succeed(repoDir),
            getCurrentBranch: () => Effect.succeed("feature"),
          },
          tmux: {
            ...liveTmuxService,
            createSession: (name, workingDir) =>
              Effect.sync(() => {
                calls.push(`tmux:${name}:${workingDir}`);
                return { _tag: "AlreadyExists" as const, sessionName: name };
              }),
          },
          ide: {
            openIDE: (_command, env) =>
              Effect.sync(() => {
                calls.push(`ide:${env.WCT_BRANCH}`);
              }),
          },
          setup: {
            runSetupCommands: () =>
              Effect.sync(() => {
                calls.push("setup");
                return [];
              }),
          },
        },
      ),
    );

    expect(result.attempts.tmux).toEqual({
      attempted: true,
      ok: true,
      value: { _tag: "AlreadyExists", sessionName: "myapp-feature" },
    });
    expect(result.attempts.ide).toEqual({
      attempted: true,
      ok: true,
      value: null,
    });
    expect(result.warnings).toEqual([]);
    expect(calls).toContain(`tmux:myapp-feature:${worktreePath}`);
    expect(calls).toContain("ide:feature");
    expect(calls).not.toContain("setup");
    expect(await Bun.file(copiedFile).exists()).toBe(false);
  });

  test("uses explicit profile config for tmux and IDE behavior", async () => {
    await writeConfig(
      repoDir,
      `profiles:
  focused:
    tmux:
      windows:
        - name: "profile-window"
    ide:
      command: "echo profile-ide"
`,
    );
    const tmuxWindowNames: Array<string | undefined> = [];
    const ideCommands: string[] = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.up({ path: worktreePath, profile: "focused" }),
        ),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(repoDir),
            getCurrentBranch: () => Effect.succeed("feature"),
          },
          tmux: {
            ...liveTmuxService,
            createSession: (name, _workingDir, config) =>
              Effect.sync(() => {
                tmuxWindowNames.push(config?.windows?.[0]?.name);
                return { _tag: "Created" as const, sessionName: name };
              }),
          },
          ide: {
            openIDE: (command) =>
              Effect.sync(() => {
                ideCommands.push(command);
              }),
          },
        },
      ),
    );

    expect(result.profileName).toBe("focused");
    expect(tmuxWindowNames).toEqual(["profile-window"]);
    expect(ideCommands).toEqual(["echo profile-ide"]);
  });

  test("captures tmux and IDE failures as JSON-safe warnings and attempts", async () => {
    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.up({ path: worktreePath })),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(repoDir),
            getCurrentBranch: () => Effect.succeed("feature"),
          },
          tmux: {
            ...liveTmuxService,
            createSession: () =>
              Effect.fail(commandError("tmux_error", "tmux boom")),
          },
          ide: {
            openIDE: () =>
              Effect.fail(commandError("unexpected_error", "ide boom")),
          },
        },
      ),
    );

    expect(result.attempts.tmux).toMatchObject({
      attempted: true,
      ok: false,
      error: { code: "tmux_error", message: "tmux boom" },
    });
    expect(result.attempts.ide).toMatchObject({
      attempted: true,
      ok: false,
      error: { code: "unexpected_error", message: "ide boom" },
    });
    expect(result.warnings).toEqual([
      {
        _tag: "TmuxStartFailed",
        operation: "up",
        error: { code: "tmux_error", message: "tmux boom" },
      },
      {
        _tag: "IdeOpenFailed",
        operation: "up",
        error: { code: "unexpected_error", message: "ide boom" },
      },
    ]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
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
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
          },
          tmux: {
            ...liveTmuxService,
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
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
          },
          tmux: {
            ...liveTmuxService,
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
              ...liveWorktreeService,
              findWorktreeByBranch: () => Effect.succeed(null),
            },
          },
        ),
      ),
    ).rejects.toThrow("No worktree found for branch 'missing-branch'");
  });

  test("treats tmux kill failure as fatal", async () => {
    const tmux: TmuxService = {
      ...liveTmuxService,
      sessionExists: () => Effect.succeed(true),
      killSession: () => Effect.fail(commandError("tmux_error", "kill boom")),
    };

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) => service.down()),
          {
            worktree: {
              ...liveWorktreeService,
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
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            removeWorktree: (path, force) =>
              Effect.sync(() => {
                removeCalls.push({ path, force });
                return { _tag: "Removed" as const, path };
              }),
          },
          tmux: {
            ...liveTmuxService,
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
            ...liveWorktreeService,
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
            ...liveTmuxService,
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

  test("resolves explicit path targets", async () => {
    const seenPaths: string[] = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.close({ path: "/tmp/myapp-explicit" }),
        ),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: (cwd) =>
              Effect.sync(() => {
                if (cwd) seenPaths.push(cwd);
                return true;
              }),
            removeWorktree: (path) =>
              Effect.succeed({ _tag: "Removed" as const, path }),
          },
          tmux: {
            ...liveTmuxService,
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
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
              removeWorktree: (path) =>
                Effect.sync(() => {
                  removeCalls.push(path);
                  return { _tag: "Removed" as const, path };
                }),
            },
            tmux: {
              ...liveTmuxService,
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
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            removeWorktree: (path) =>
              Effect.succeed({ _tag: "BlockedByChanges" as const, path }),
          },
          tmux: {
            ...liveTmuxService,
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
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            removeWorktree: (path, force) =>
              Effect.sync(() => {
                forceArgs.push(force);
                return { _tag: "Removed" as const, path };
              }),
          },
          tmux: {
            ...liveTmuxService,
            sessionExists: () => Effect.succeed(false),
          },
        },
      ),
    );

    expect(result.status).toBe("removed");
    expect(forceArgs).toEqual([true]);
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

  test("emits up events in deterministic operation order while starting tmux and IDE in parallel", async () => {
    const events: WorkspaceReporterEvent[] = [];
    const calls: string[] = [];
    let ideStarted = false;

    const reporter = {
      event: (event: WorkspaceReporterEvent) =>
        Effect.sync(() => {
          events.push(event);
        }),
    };

    const result = await Promise.race([
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.up({ path: "/tmp/myapp-feature", reporter }),
          ),
          {
            worktree: {
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
              getMainRepoPath: () => Effect.succeed(repoDir),
              getCurrentBranch: () => Effect.succeed("feature"),
            },
            tmux: {
              ...liveTmuxService,
              createSession: (name) =>
                Effect.promise(async () => {
                  calls.push("tmux-started");
                  while (!ideStarted) {
                    await Bun.sleep(1);
                  }
                  calls.push("tmux-completed");
                  return { _tag: "Created" as const, sessionName: name };
                }),
            },
            ide: {
              openIDE: () =>
                Effect.promise(async () => {
                  calls.push("ide-started");
                  ideStarted = true;
                  await Bun.sleep(1);
                  calls.push("ide-completed");
                }),
            },
          },
        ),
      ),
      Bun.sleep(100).then(() => {
        throw new Error("workspace up did not start tmux and IDE in parallel");
      }),
    ]);

    expect(result.attempts.tmux).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result.attempts.ide).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result).not.toHaveProperty("events");
    expect(calls).toEqual([
      "tmux-started",
      "ide-started",
      "tmux-completed",
      "ide-completed",
    ]);
    expect(events).toEqual([
      {
        operation: "up",
        _tag: "TargetResolved",
        worktreePath: "/tmp/myapp-feature",
      },
      {
        operation: "up",
        _tag: "ProfileResolved",
      },
      {
        operation: "up",
        _tag: "AttemptStarted",
        attempt: "tmux",
      },
      {
        operation: "up",
        _tag: "AttemptStarted",
        attempt: "ide",
      },
      {
        operation: "up",
        _tag: "AttemptCompleted",
        attempt: "tmux",
        ok: true,
      },
      {
        operation: "up",
        _tag: "AttemptCompleted",
        attempt: "ide",
        ok: true,
      },
    ]);
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
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
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
            },
            tmux: {
              ...liveTmuxService,
              sessionExists: () => Effect.succeed(false),
            },
          },
        ),
      ),
    ).resolves.toMatchObject({ status: "absent" });

    expect(events).toEqual([
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
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
            },
            tmux: {
              ...liveTmuxService,
              sessionExists: () => Effect.succeed(false),
            },
          },
        ),
      ),
    ).resolves.toMatchObject({ status: "absent" });
  });
});

test("liveWorkspaceService exposes public lifecycle operations for this slice", () => {
  expect(typeof liveWorkspaceService.open).toBe("function");
  expect(typeof liveWorkspaceService.up).toBe("function");
  expect(typeof liveWorkspaceService.down).toBe("function");
  expect(typeof liveWorkspaceService.close).toBe("function");
});

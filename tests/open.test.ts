import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  openCommand,
  openWorktree,
  resolveOpenOptions,
} from "../src/commands/open";
import { DEFAULT_IDE_CONFIG } from "../src/config/loader";
import { runBunPromise } from "../src/effect/runtime";
import {
  type GitHubService,
  liveGitHubService,
} from "../src/services/github-service";
import { type IdeService, liveIdeService } from "../src/services/ide-service";
import {
  liveRegistryService,
  type RegistryServiceApi,
} from "../src/services/registry-service";
import { liveTmuxService } from "../src/services/tmux";
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

interface OpenWorkflowFixture {
  homeDir: string;
  repoDir: string;
  worktreeDir: string;
}

async function createOpenWorkflowFixture(): Promise<OpenWorkflowFixture> {
  const repoDir = await realpath(
    await mkdtemp(join(tmpdir(), "wct-open-repo-")),
  );
  const homeDir = await realpath(
    await mkdtemp(join(tmpdir(), "wct-open-home-")),
  );
  const worktreeDir = resolve(repoDir, "worktrees");

  await $`git init -b main`.quiet().cwd(repoDir);
  await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
  await $`git config user.name "Test"`.quiet().cwd(repoDir);
  await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
  await $`git commit --allow-empty -m "initial"`.quiet().cwd(repoDir);

  await Bun.write(
    join(repoDir, ".wct.yaml"),
    `version: 1
worktree_dir: "worktrees"
project_name: "myapp"
`,
  );

  return { homeDir, repoDir, worktreeDir };
}

async function cleanupOpenWorkflowFixture(
  fixture: OpenWorkflowFixture,
): Promise<void> {
  await rm(fixture.repoDir, { recursive: true, force: true });
  await rm(fixture.homeDir, { recursive: true, force: true });
  await rm(fixture.worktreeDir, { recursive: true, force: true });
}

describe("resolveOpenOptions", () => {
  test("rejects --ide together with --no-ide", async () => {
    await expect(
      runResolveOpenOptions({
        branch: "feature-branch",
        ide: true,
        noIde: true,
      }),
    ).rejects.toThrow("Options --ide and --no-ide cannot be used together");
  });

  test("passes through positive ide flag", async () => {
    await expect(
      runResolveOpenOptions({
        branch: "feature-branch",
        ide: true,
      }),
    ).resolves.toMatchObject({
      ide: true,
      noIde: false,
    });
  });

  test("rejects branch argument together with --pr", async () => {
    await expect(
      runResolveOpenOptions({
        branch: "feature-branch",
        pr: "123",
      }),
    ).rejects.toThrow("Cannot use --pr together with a branch argument");
  });

  test("rejects --existing together with --pr", async () => {
    await expect(
      runResolveOpenOptions({
        pr: "123",
        existing: true,
      }),
    ).rejects.toThrow("Cannot use --pr together with --existing");
  });

  test("normalizes PR options into branch and base after fetching", async () => {
    const calls: Array<{ branch: string; cwd?: string; remote?: string }> = [];
    const branchExistsCalls: Array<{ branch: string; cwd?: string }> = [];
    const githubOverrides: GitHubService = {
      ...liveGitHubService,
      isGhInstalled: () => Effect.succeed(true),
      resolvePr: (prNumber: number, cwd?: string) =>
        Effect.succeed({
          branch: "feature-from-pr",
          prNumber,
          cwd,
          isCrossRepository: false,
          headOwner: "acme",
          headRepo: "wct",
        }),
      findRemoteForRepo: (_owner: string, _repo: string, cwd?: string) =>
        Effect.succeed(cwd ? "origin" : "missing-cwd"),
      fetchBranch: (branch: string, remote?: string, cwd?: string) =>
        Effect.sync(() => {
          calls.push({ branch, remote, cwd });
        }),
    };
    const worktreeOverrides: WorktreeService = {
      ...liveWorktreeService,
      branchExists: (branch: string, cwd?: string) =>
        Effect.sync(() => {
          branchExistsCalls.push({ branch, cwd });
          return false;
        }),
    };

    await expect(
      runResolveOpenOptions(
        {
          cwd: "/repo",
          pr: "123",
          noIde: true,
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
      cwd: "/repo",
      ide: false,
      noIde: true,
      prompt: "focus",
      profile: "default",
    });

    expect(calls).toEqual([
      {
        branch: "feature-from-pr",
        cwd: "/repo",
        remote: "origin",
      },
    ]);
    expect(branchExistsCalls).toEqual([
      {
        branch: "feature-from-pr",
        cwd: "/repo",
      },
    ]);
  });
});

describe("open workflow", () => {
  let fixture: OpenWorkflowFixture;
  const originalHome = process.env.HOME;

  beforeAll(async () => {
    fixture = await createOpenWorkflowFixture();
    process.env.HOME = fixture.homeDir;
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    await cleanupOpenWorkflowFixture(fixture);
  });

  test("openWorktree returns created false when the worktree already exists", async () => {
    const createCalls: Array<{
      branch: string;
      cwd?: string;
      existing: boolean;
      path: string;
      base?: string;
    }> = [];
    const repoCalls: Array<{ cwd?: string; method: string }> = [];
    const registerCalls: Array<{ path: string; name: string }> = [];

    const result = await runBunPromise(
      withTestServices(
        openWorktree({
          branch: "feature-branch",
          cwd: fixture.repoDir,
          existing: false,
        }),
        {
          registry: {
            ...liveRegistryService,
            register: (path: string, name: string) =>
              Effect.sync(() => {
                registerCalls.push({ path, name });
                return {
                  id: "registry-item",
                  repo_path: path,
                  project: name,
                  created_at: 1,
                };
              }),
          } satisfies RegistryServiceApi,
          worktree: {
            ...liveWorktreeService,
            isGitRepo: (cwd?: string) =>
              Effect.sync(() => {
                repoCalls.push({ method: "isGitRepo", cwd });
                return true;
              }),
            getMainRepoPath: (cwd?: string) =>
              Effect.sync(() => {
                repoCalls.push({ method: "getMainRepoPath", cwd });
                return fixture.repoDir;
              }),
            branchExists: (_branch: string, cwd?: string) =>
              Effect.sync(() => {
                repoCalls.push({ method: "branchExists", cwd });
                return false;
              }),
            createWorktree: (path, branch, existing, base, cwd) =>
              Effect.sync(() => {
                createCalls.push({ path, branch, existing, base, cwd });
                return {
                  _tag: "AlreadyExists" as const,
                  path,
                };
              }),
          },
        },
      ),
    );

    expect(result).toEqual({
      worktreePath: join(fixture.worktreeDir, "myapp-feature-branch"),
      branch: "feature-branch",
      sessionName: "myapp-feature-branch",
      projectName: "myapp",
      created: false,
      warnings: [],
      tmuxSessionStarted: false,
    });
    expect(createCalls).toEqual([
      {
        path: join(fixture.worktreeDir, "myapp-feature-branch"),
        branch: "feature-branch",
        cwd: fixture.repoDir,
        existing: false,
        base: undefined,
      },
    ]);
    expect(repoCalls).toEqual([
      { method: "isGitRepo", cwd: fixture.repoDir },
      { method: "getMainRepoPath", cwd: fixture.repoDir },
      { method: "getMainRepoPath", cwd: fixture.repoDir },
    ]);
    expect(registerCalls).toEqual([
      {
        path: fixture.repoDir,
        name: "myapp",
      },
    ]);
  });

  test("openWorktree reports tmuxSessionStarted false when no tmux config exists", async () => {
    const result = await runBunPromise(
      withTestServices(
        openWorktree({
          branch: "feature-branch",
          cwd: fixture.repoDir,
          existing: false,
        }),
        {
          registry: {
            ...liveRegistryService,
            register: (path: string, name: string) =>
              Effect.succeed({
                id: "registry-item",
                repo_path: path,
                project: name,
                created_at: 1,
              }),
          } satisfies RegistryServiceApi,
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(fixture.repoDir),
            branchExists: () => Effect.succeed(false),
            createWorktree: (path, _branch, _existing, _base) =>
              Effect.succeed({ _tag: "Created" as const, path }),
          },
        },
      ),
    );

    expect(result.tmuxSessionStarted).toBe(false);
  });

  test("does not open IDE by default when config omits ide", async () => {
    const ideCalls: string[] = [];
    const result = await runBunPromise(
      withTestServices(
        openWorktree({
          branch: "no-default-ide-branch",
          cwd: fixture.repoDir,
          existing: false,
        }),
        {
          ide: {
            ...liveIdeService,
            openIDE: (command) =>
              Effect.sync(() => {
                ideCalls.push(command);
              }),
          } satisfies IdeService,
          registry: {
            ...liveRegistryService,
            register: (path: string, name: string) =>
              Effect.succeed({
                id: "registry-item",
                repo_path: path,
                project: name,
                created_at: 1,
              }),
          } satisfies RegistryServiceApi,
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(fixture.repoDir),
            branchExists: () => Effect.succeed(false),
            createWorktree: (path) =>
              Effect.succeed({ _tag: "Created" as const, path }),
          },
        },
      ),
    );

    expect(result.tmuxSessionStarted).toBe(false);
    expect(ideCalls).toEqual([]);
  });

  test("opens fallback IDE when --ide is passed and config omits ide", async () => {
    const ideCalls: string[] = [];
    const result = await runBunPromise(
      withTestServices(
        openWorktree({
          branch: "forced-default-ide-branch",
          cwd: fixture.repoDir,
          existing: false,
          ide: true,
        }),
        {
          ide: {
            ...liveIdeService,
            openIDE: (command) =>
              Effect.sync(() => {
                ideCalls.push(command);
              }),
          } satisfies IdeService,
          registry: {
            ...liveRegistryService,
            register: (path: string, name: string) =>
              Effect.succeed({
                id: "registry-item",
                repo_path: path,
                project: name,
                created_at: 1,
              }),
          } satisfies RegistryServiceApi,
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(fixture.repoDir),
            branchExists: () => Effect.succeed(false),
            createWorktree: (path) =>
              Effect.succeed({ _tag: "Created" as const, path }),
          },
        },
      ),
    );

    expect(result.tmuxSessionStarted).toBe(false);
    expect(ideCalls).toEqual([DEFAULT_IDE_CONFIG.command]);
  });

  test("openCommand prints attach guidance when --no-attach is set and tmux started", async () => {
    const originalTmux = process.env.TMUX;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const wctYamlPath = join(fixture.repoDir, ".wct.yaml");
    const originalYaml = await Bun.file(wctYamlPath).text();
    await Bun.write(
      wctYamlPath,
      `version: 1\nworktree_dir: "worktrees"\nproject_name: "myapp"\ntmux: {}\n`,
    );

    delete process.env.TMUX;

    try {
      await expect(
        runBunPromise(
          withTestServices(
            openCommand({
              branch: "no-attach-branch",
              existing: false,
              noAttach: true,
              cwd: fixture.repoDir,
            }),
            {
              registry: {
                ...liveRegistryService,
                register: (path: string, name: string) =>
                  Effect.succeed({
                    id: "registry-item",
                    repo_path: path,
                    project: name,
                    created_at: 1,
                  }),
              } satisfies RegistryServiceApi,
              worktree: {
                ...liveWorktreeService,
                isGitRepo: () => Effect.succeed(true),
                getMainRepoPath: () => Effect.succeed(fixture.repoDir),
                branchExists: () => Effect.succeed(false),
                createWorktree: (path, _branch, _existing, _base) =>
                  Effect.succeed({ _tag: "Created" as const, path }),
              },
              tmux: {
                ...liveTmuxService,
                createSession: () =>
                  Effect.succeed({
                    _tag: "Created" as const,
                    sessionName: "myapp-no-attach-branch",
                  }),
              },
            },
          ),
        ),
      ).resolves.toBeUndefined();

      const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(
        loggedLines.some((line) => line.includes("Attach to tmux session")),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      await Bun.write(wctYamlPath, originalYaml);
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
    }
  });

  test("openCommand skips maybeAttachSession when tmuxSessionStarted is false", async () => {
    const originalTmux = process.env.TMUX;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    delete process.env.TMUX;

    try {
      await expect(
        runBunPromise(
          withTestServices(
            openCommand({
              branch: "no-tmux-branch",
              existing: false,
              cwd: fixture.repoDir,
            }),
            {
              registry: {
                ...liveRegistryService,
                register: (path: string, name: string) =>
                  Effect.succeed({
                    id: "registry-item",
                    repo_path: path,
                    project: name,
                    created_at: 1,
                  }),
              } satisfies RegistryServiceApi,
              worktree: {
                ...liveWorktreeService,
                isGitRepo: () => Effect.succeed(true),
                getMainRepoPath: () => Effect.succeed(fixture.repoDir),
                branchExists: () => Effect.succeed(false),
                createWorktree: (path, _branch, _existing, _base) =>
                  Effect.succeed({ _tag: "Created" as const, path }),
              },
            },
          ),
        ),
      ).resolves.toBeUndefined();

      const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(
        loggedLines.some((line) => line.includes("Attach to tmux session")),
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
    }
  });

  test("openCommand delegates to openWorktree and resolves void", async () => {
    const createCalls: Array<{
      branch: string;
      existing: boolean;
      path: string;
      base?: string;
    }> = [];

    const result = await runBunPromise(
      withTestServices(
        openCommand({
          branch: "feature-branch",
          existing: false,
        }),
        {
          registry: {
            ...liveRegistryService,
            register: (path: string, name: string) =>
              Effect.succeed({
                id: "registry-item",
                repo_path: path,
                project: name,
                created_at: 1,
              }),
          } satisfies RegistryServiceApi,
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(fixture.repoDir),
            branchExists: () => Effect.succeed(false),
            createWorktree: (path, branch, existing, base) =>
              Effect.sync(() => {
                createCalls.push({ path, branch, existing, base });
                return {
                  _tag: "Created" as const,
                  path,
                };
              }),
          },
        },
      ),
    );

    expect(result).toBeUndefined();
    expect(createCalls).toEqual([
      {
        path: join(fixture.worktreeDir, "myapp-feature-branch"),
        branch: "feature-branch",
        existing: false,
        base: undefined,
      },
    ]);
  });
});

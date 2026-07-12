import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { openCommand } from "../src/commands/open";
import { runBunPromise } from "../src/effect/runtime";
import { WctCommandError } from "../src/errors";
import {
  liveRegistryService,
  type RegistryItem,
  type RegistryRegistrationResult,
  type RegistryServiceApi,
} from "../src/services/registry-service";
import {
  type WorkspaceOpenOptions,
  type WorkspaceOpenResult,
  WorkspaceService,
} from "../src/services/workspace-service";
import { liveWorktreeService } from "../src/services/worktree-service";
import { noopTmuxService, withTestServices } from "./helpers/services";

function registeredResult(
  path: string,
  project: string,
): RegistryRegistrationResult {
  return {
    status: "registered",
    item: {
      id: "registry-item",
      repo_path: path,
      project,
      created_at: 1,
    } satisfies RegistryItem,
  };
}

function alreadyRegisteredResult(
  path: string,
  project: string,
): RegistryRegistrationResult {
  return {
    status: "already-registered",
    item: {
      id: "registry-item",
      repo_path: path,
      project,
      created_at: 1,
    } satisfies RegistryItem,
  };
}

async function expectWctFailure(
  effect: Effect.Effect<unknown, unknown, never>,
  code: string,
  message: string,
) {
  try {
    await runBunPromise(effect);
    throw new Error("Expected command to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WctCommandError);
    expect((error as WctCommandError).code).toBe(code);
    expect((error as WctCommandError).message).toContain(message);
  }
}

function workspaceOpen(options: WorkspaceOpenOptions) {
  return WorkspaceService.use((service) => service.open(options));
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

describe("WorkspaceService open validation", () => {
  test("rejects branch argument together with --pr", async () => {
    await expectWctFailure(
      withTestServices(
        workspaceOpen({
          branch: "feature-branch",
          pr: "123",
        }),
      ),
      "invalid_options",
      "Cannot use --pr together with a branch argument",
    );
  });

  test("rejects --existing together with --pr", async () => {
    await expectWctFailure(
      withTestServices(
        workspaceOpen({
          pr: "123",
          existing: true,
        }),
      ),
      "invalid_options",
      "Cannot use --pr together with --existing",
    );
  });

  test("rejects --base together with --pr", async () => {
    await expectWctFailure(
      withTestServices(
        workspaceOpen({
          pr: "123",
          base: "main",
        }),
      ),
      "invalid_options",
      "Cannot use --pr together with --base",
    );
  });

  test("rejects missing branch before repository validation", async () => {
    await expectWctFailure(
      withTestServices(workspaceOpen({}), {
        worktree: {
          ...liveWorktreeService,
          isGitRepo: () => Effect.die("repository should not be checked"),
        },
      }),
      "missing_branch_arg",
      "Missing branch name",
    );
  });

  test("rejects invalid PR values before checking gh", async () => {
    await expectWctFailure(
      withTestServices(
        workspaceOpen({
          pr: "not-a-pr",
        }),
      ),
      "pr_error",
      "Invalid --pr value: 'not-a-pr'",
    );
  });

  test("validation ordering keeps branch plus --pr before --pr plus --base", async () => {
    await expectWctFailure(
      withTestServices(
        workspaceOpen({
          branch: "feature",
          pr: "123",
          base: "main",
        }),
      ),
      "invalid_options",
      "Cannot use --pr together with a branch argument",
    );
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

  test("WorkspaceService.open returns created false when the worktree already exists", async () => {
    const createCalls: Array<{
      branch: string;
      cwd?: string;
      existing: boolean;
      path: string;
      base?: string;
    }> = [];
    const repoCalls: Array<{ cwd?: string; method: string }> = [];

    const result = await runBunPromise(
      withTestServices(
        workspaceOpen({
          branch: "feature-branch",
          cwd: fixture.repoDir,
          existing: false,
        }),
        {
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

    expect(result).toMatchObject({
      worktreePath: join(fixture.worktreeDir, "myapp-feature-branch"),
      mainRepoPath: fixture.repoDir,
      branch: "feature-branch",
      sessionName: "myapp-feature-branch",
      projectName: "myapp",
      created: false,
      warnings: [],
    });
    expect(result.attempts.tmux).toMatchObject({ attempted: false });
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
    ]);
  });

  test("WorkspaceService.open skips tmux when no tmux config exists", async () => {
    const result = await runBunPromise(
      withTestServices(
        workspaceOpen({
          branch: "feature-branch",
          cwd: fixture.repoDir,
          existing: false,
        }),
        {
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

    expect(result.attempts.tmux).toMatchObject({ attempted: false });
  });

  test("validates --existing plus --base and missing base after config resolution", async () => {
    await expectWctFailure(
      withTestServices(
        workspaceOpen({
          branch: "feature",
          cwd: fixture.repoDir,
          existing: true,
          base: "main",
        }),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(fixture.repoDir),
          },
        },
      ),
      "invalid_options",
      "Options --existing and --base cannot be used together",
    );

    await expectWctFailure(
      withTestServices(
        workspaceOpen({
          branch: "feature",
          cwd: fixture.repoDir,
          base: "missing-base",
        }),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(fixture.repoDir),
            branchExists: (branch) => Effect.succeed(branch !== "missing-base"),
          },
        },
      ),
      "base_branch_not_found",
      "Base branch 'missing-base' does not exist",
    );
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
              worktree: {
                ...liveWorktreeService,
                isGitRepo: () => Effect.succeed(true),
                getMainRepoPath: () => Effect.succeed(fixture.repoDir),
                branchExists: () => Effect.succeed(false),
                createWorktree: (path, _branch, _existing, _base) =>
                  Effect.succeed({ _tag: "Created" as const, path }),
              },
              tmux: {
                ...noopTmuxService,
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

  test("openCommand skips maybeAttachSession when WorkspaceService does not start tmux", async () => {
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

  test("openCommand uses WorkspaceService.open and resolves void", async () => {
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

  test("openCommand does not register projects after Workspace open succeeds", async () => {
    const registerCalls: string[] = [];
    const workspaceResult: WorkspaceOpenResult = {
      operation: "open",
      worktreePath: "/tmp/myapp-no-registration",
      mainRepoPath: fixture.repoDir,
      branch: "no-registration",
      sessionName: "myapp-no-registration",
      projectName: "myapp",
      created: true,
      env: {
        WCT_WORKTREE_DIR: "/tmp/myapp-no-registration",
        WCT_WORK_DIR: "/tmp/myapp-no-registration",
        WCT_MAIN_DIR: fixture.repoDir,
        WCT_BRANCH: "no-registration",
        WCT_PROJECT: "myapp",
      },
      warnings: [],
      attempts: {
        worktree: {
          attempted: true,
          ok: true,
          value: {
            _tag: "Created",
            path: "/tmp/myapp-no-registration",
          },
        },
        copy: { attempted: false, reason: "copy_not_configured" },
        setup: { attempted: false, reason: "setup_not_configured" },
        tmux: { attempted: false, reason: "tmux_not_configured" },
      },
    };

    await runBunPromise(
      withTestServices(
        openCommand({
          branch: "no-registration",
          existing: false,
        }),
        {
          workspace: {
            open: () => Effect.succeed(workspaceResult),
            up: () => Effect.die("unused"),
            down: () => Effect.die("unused"),
            close: () => Effect.die("unused"),
          },
          registry: {
            ...liveRegistryService,
            register: (path: string) =>
              Effect.sync(() => {
                registerCalls.push(path);
                return registeredResult(path, "myapp");
              }),
          } satisfies RegistryServiceApi,
        },
      ),
    );

    expect(registerCalls).toEqual([]);
  });

  test("openCommand JSON emits final workspace result without registration outcome", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const registerCalls: string[] = [];
    const workspaceResult: WorkspaceOpenResult = {
      operation: "open" as const,
      worktreePath: "/tmp/myapp-json",
      mainRepoPath: fixture.repoDir,
      branch: "json",
      sessionName: "myapp-json",
      projectName: "myapp",
      created: true,
      env: {
        WCT_WORKTREE_DIR: "/tmp/myapp-json",
        WCT_WORK_DIR: "/tmp/myapp-json",
        WCT_MAIN_DIR: fixture.repoDir,
        WCT_BRANCH: "json",
        WCT_PROJECT: "myapp",
      },
      warnings: [
        {
          _tag: "TmuxStartFailed",
          operation: "open",
          error: {
            code: "tmux_error",
            message: "tmux unavailable",
          },
        },
      ],
      attempts: {
        worktree: {
          attempted: true as const,
          ok: true as const,
          value: { _tag: "Created" as const, path: "/tmp/myapp-json" },
        },
        copy: { attempted: false as const, reason: "copy_not_configured" },
        setup: { attempted: false as const, reason: "setup_not_configured" },
        tmux: {
          attempted: true as const,
          ok: false as const,
          error: {
            code: "tmux_error",
            message: "tmux unavailable",
          },
        },
      },
    };

    try {
      await runBunPromise(
        withTestServices(
          openCommand({
            branch: "json",
            existing: false,
          }),
          {
            json: true,
            workspace: {
              open: (options) => {
                expect(options.reporter).toBeUndefined();
                return Effect.succeed(workspaceResult);
              },
              up: () => Effect.die("unused"),
              down: () => Effect.die("unused"),
              close: () => Effect.die("unused"),
            },
            registry: {
              ...liveRegistryService,
              register: (path: string, name: string) =>
                Effect.sync(() => {
                  registerCalls.push(`${path}:${name}`);
                  return registeredResult(path, name);
                }),
            } satisfies RegistryServiceApi,
          },
        ),
      );

      const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
      expect(output).toMatchObject({
        ok: true,
        data: {
          workspace: workspaceResult,
        },
      });
      expect(output.data.workspace.warnings).toEqual(workspaceResult.warnings);
      expect(output.data.workspace.attempts.tmux).toEqual(
        workspaceResult.attempts.tmux,
      );
      expect(output.data.registration).toBeUndefined();
      expect(registerCalls).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("openCommand passes a human reporter without project registration", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const registerCalls: string[] = [];
    const workspaceResult = {
      operation: "open" as const,
      worktreePath: "/tmp/myapp-human",
      mainRepoPath: fixture.repoDir,
      branch: "human",
      sessionName: "myapp-human",
      projectName: "myapp",
      created: true,
      env: {
        WCT_WORKTREE_DIR: "/tmp/myapp-human",
        WCT_WORK_DIR: "/tmp/myapp-human",
        WCT_MAIN_DIR: fixture.repoDir,
        WCT_BRANCH: "human",
        WCT_PROJECT: "myapp",
      },
      warnings: [],
      attempts: {
        worktree: {
          attempted: true as const,
          ok: true as const,
          value: { _tag: "Created" as const, path: "/tmp/myapp-human" },
        },
        copy: { attempted: false as const, reason: "copy_not_configured" },
        setup: { attempted: false as const, reason: "setup_not_configured" },
        tmux: { attempted: false as const, reason: "tmux_not_configured" },
      },
    };

    try {
      await runBunPromise(
        withTestServices(
          openCommand({
            branch: "human",
            existing: false,
          }),
          {
            workspace: {
              open: (options) =>
                Effect.gen(function* () {
                  const reporter = options.reporter;
                  expect(reporter).toBeDefined();
                  if (reporter) {
                    yield* Effect.catch(
                      reporter.event({
                        operation: "open",
                        _tag: "AttemptStarted",
                        attempt: "copy",
                      }),
                      () => Effect.void,
                    );
                  }
                  return workspaceResult;
                }),
              up: () => Effect.die("unused"),
              down: () => Effect.die("unused"),
              close: () => Effect.die("unused"),
            },
            registry: {
              ...liveRegistryService,
              register: (path: string, name: string) =>
                Effect.sync(() => {
                  registerCalls.push(`${path}:${name}`);
                  return alreadyRegisteredResult(path, name);
                }),
            } satisfies RegistryServiceApi,
          },
        ),
      );

      const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(loggedLines.some((line) => line.includes("Copying files"))).toBe(
        true,
      );
      expect(
        loggedLines.some((line) => line.includes("Registered project")),
      ).toBe(false);
      expect(registerCalls).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("openCommand human reporter logs resolved PR branch and base", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const workspaceResult: WorkspaceOpenResult = {
      operation: "open",
      worktreePath: "/tmp/myapp-pr-branch",
      mainRepoPath: fixture.repoDir,
      branch: "pr-branch",
      sessionName: "myapp-pr-branch",
      projectName: "myapp",
      created: true,
      env: {
        WCT_WORKTREE_DIR: "/tmp/myapp-pr-branch",
        WCT_WORK_DIR: "/tmp/myapp-pr-branch",
        WCT_MAIN_DIR: fixture.repoDir,
        WCT_BRANCH: "pr-branch",
        WCT_PROJECT: "myapp",
      },
      warnings: [],
      attempts: {
        worktree: {
          attempted: true,
          ok: true,
          value: { _tag: "Created", path: "/tmp/myapp-pr-branch" },
        },
        copy: { attempted: false, reason: "copy_not_configured" },
        setup: { attempted: false, reason: "setup_not_configured" },
        tmux: { attempted: false, reason: "tmux_not_configured" },
      },
    };

    try {
      await runBunPromise(
        withTestServices(
          openCommand({
            pr: "42",
            existing: false,
          }),
          {
            workspace: {
              open: (options) =>
                Effect.gen(function* () {
                  if (options.reporter) {
                    yield* Effect.catch(
                      options.reporter.event({
                        operation: "open",
                        _tag: "TargetResolved",
                        worktreePath: workspaceResult.worktreePath,
                        branch: "pr-branch",
                        base: "alice/pr-branch",
                      }),
                      () => Effect.void,
                    );
                    yield* Effect.catch(
                      options.reporter.event({
                        operation: "open",
                        _tag: "AttemptStarted",
                        attempt: "worktree",
                      }),
                      () => Effect.void,
                    );
                  }
                  return workspaceResult;
                }),
              up: () => Effect.die("unused"),
              down: () => Effect.die("unused"),
              close: () => Effect.die("unused"),
            },
          },
        ),
      );

      const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(
        loggedLines.some((line) =>
          line.includes(
            "Creating worktree for 'pr-branch' based on 'alice/pr-branch'",
          ),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

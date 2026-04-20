import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  openCommand,
  openWorktree,
  resolveOpenOptions,
} from "../src/commands/open";
import { runBunPromise } from "../src/effect/runtime";
import {
  type GitHubService,
  liveGitHubService,
} from "../src/services/github-service";
import {
  liveRegistryService,
  type RegistryServiceApi,
} from "../src/services/registry-service";
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
  const repoDir = await realpath(await mkdtemp(join(tmpdir(), "wct-open-repo-")));
  const homeDir = await realpath(await mkdtemp(join(tmpdir(), "wct-open-home-")));
  const worktreeDir = resolve(repoDir, "../worktrees");

  await $`git init -b main`.quiet().cwd(repoDir);
  await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
  await $`git config user.name "Test"`.quiet().cwd(repoDir);
  await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
  await $`git commit --allow-empty -m "initial"`.quiet().cwd(repoDir);

  await Bun.write(
    join(repoDir, ".wct.yaml"),
    `version: 1
worktree_dir: "../worktrees"
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
      existing: boolean;
      path: string;
      base?: string;
    }> = [];
    const registerCalls: Array<{ path: string; name: string }> = [];

    const result = await runBunPromise(
      withTestServices(
        openWorktree({
          branch: "feature-branch",
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
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(fixture.repoDir),
            branchExists: () => Effect.succeed(false),
            createWorktree: (path, branch, existing, base) =>
              Effect.sync(() => {
                createCalls.push({ path, branch, existing, base });
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
    });
    expect(createCalls).toEqual([
      {
        path: join(fixture.worktreeDir, "myapp-feature-branch"),
        branch: "feature-branch",
        existing: false,
        base: undefined,
      },
    ]);
    expect(registerCalls).toEqual([
      {
        path: fixture.repoDir,
        name: "myapp",
      },
    ]);
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

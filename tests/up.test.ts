import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { upCommand } from "../src/commands/up";
import {
  getCurrentBranch,
  getMainRepoPath,
  getMainWorktreePath,
} from "../src/services/worktree";

describe("getCurrentBranch", () => {
  test("returns current branch name in a git repo", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "wct-test-branch-"));
    const originalDir = process.cwd();

    try {
      await $`git init -b test-branch`.quiet().cwd(tempDir);
      await $`git config user.email "test@test.com"`.quiet().cwd(tempDir);
      await $`git config user.name "Test"`.quiet().cwd(tempDir);
      await $`git config commit.gpgSign false`.quiet().cwd(tempDir);
      await $`git commit --allow-empty -m "initial"`.quiet().cwd(tempDir);

      process.chdir(tempDir);
      const branch = await getCurrentBranch();
      expect(branch).toBe("test-branch");
    } finally {
      process.chdir(originalDir);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns null on detached HEAD", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "wct-test-detached-"));
    const originalDir = process.cwd();

    try {
      await $`git init -b main`.quiet().cwd(tempDir);
      await $`git config user.email "test@test.com"`.quiet().cwd(tempDir);
      await $`git config user.name "Test"`.quiet().cwd(tempDir);
      await $`git config commit.gpgSign false`.quiet().cwd(tempDir);
      await $`git commit --allow-empty -m "initial"`.quiet().cwd(tempDir);
      const sha = await $`git rev-parse HEAD`.quiet().cwd(tempDir).text();
      await $`git checkout ${sha.trim()}`.quiet().cwd(tempDir);

      process.chdir(tempDir);
      const branch = await getCurrentBranch();
      expect(branch).toBeNull();
    } finally {
      process.chdir(originalDir);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("getMainWorktreePath", () => {
  let repoDir: string;
  let worktreeDir: string;
  const originalDir = process.cwd();

  beforeAll(async () => {
    repoDir = await realpath(
      await mkdtemp(join(tmpdir(), "wct-test-main-wt-")),
    );
    worktreeDir = await realpath(await mkdtemp(join(tmpdir(), "wct-test-wt-")));

    await $`git init -b main`.quiet().cwd(repoDir);
    await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
    await $`git config user.name "Test"`.quiet().cwd(repoDir);
    await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
    await $`git commit --allow-empty -m "initial"`.quiet().cwd(repoDir);

    const wtPath = join(worktreeDir, "feature-branch");
    await $`git worktree add -b feature-branch ${wtPath}`.quiet().cwd(repoDir);
  });

  afterAll(async () => {
    process.chdir(originalDir);
    await $`git worktree remove ${join(worktreeDir, "feature-branch")}`
      .quiet()
      .cwd(repoDir)
      .nothrow();
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeDir, { recursive: true, force: true });
  });

  test("returns main repo path when run from main repo", async () => {
    process.chdir(repoDir);
    const result = await getMainWorktreePath();
    expect(result).toBe(repoDir);
  });

  test("returns main repo path when run from a worktree", async () => {
    const wtPath = join(worktreeDir, "feature-branch");
    process.chdir(wtPath);
    const result = await getMainWorktreePath();
    expect(result).toBe(repoDir);
  });
});

describe("getMainRepoPath", () => {
  let repoDir: string;
  let worktreeDir: string;
  const originalDir = process.cwd();

  beforeAll(async () => {
    repoDir = await realpath(
      await mkdtemp(join(tmpdir(), "wct-test-main-repo-")),
    );
    worktreeDir = await realpath(
      await mkdtemp(join(tmpdir(), "wct-test-main-repo-wt-")),
    );

    await $`git init -b main`.quiet().cwd(repoDir);
    await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
    await $`git config user.name "Test"`.quiet().cwd(repoDir);
    await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
    await $`git commit --allow-empty -m "initial"`.quiet().cwd(repoDir);

    const wtPath = join(worktreeDir, "feature-branch");
    await $`git worktree add -b feature-branch ${wtPath}`.quiet().cwd(repoDir);
  });

  afterAll(async () => {
    process.chdir(originalDir);
    await $`git worktree remove ${join(worktreeDir, "feature-branch")}`
      .quiet()
      .cwd(repoDir)
      .nothrow();
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeDir, { recursive: true, force: true });
  });

  test("returns main repo path when run from main repo", async () => {
    process.chdir(repoDir);
    const result = await getMainRepoPath();
    expect(result).toBe(repoDir);
  });

  test("returns main repo path when run from a worktree", async () => {
    const wtPath = join(worktreeDir, "feature-branch");
    process.chdir(wtPath);
    const result = await getMainRepoPath();
    expect(result).toBe(repoDir);
  });
});

describe("upCommand", () => {
  test("is exported as a function", () => {
    expect(typeof upCommand).toBe("function");
  });
});

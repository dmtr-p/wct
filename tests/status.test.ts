import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  getChangedFilesCount,
  getCommitsBehind,
  getDefaultBranch,
} from "../src/commands/status";

describe("getChangedFilesCount", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "wct-status-changes-"));
    await $`git init -b main`.quiet().cwd(repoDir);
    await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
    await $`git config user.name "Test"`.quiet().cwd(repoDir);
    await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
    await $`git commit --allow-empty -m "initial commit"`.quiet().cwd(repoDir);
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  test("returns 0 for clean worktree", async () => {
    const count = await getChangedFilesCount(repoDir);
    expect(count).toBe(0);
  });

  test("counts uncommitted files", async () => {
    await $`echo "hello" > file1.txt`.quiet().cwd(repoDir);
    await $`echo "world" > file2.txt`.quiet().cwd(repoDir);

    const count = await getChangedFilesCount(repoDir);
    expect(count).toBe(2);

    // Cleanup
    await $`rm file1.txt file2.txt`.quiet().cwd(repoDir);
  });

  test("counts staged and unstaged files", async () => {
    await $`echo "staged" > staged.txt`.quiet().cwd(repoDir);
    await $`git add staged.txt`.quiet().cwd(repoDir);
    await $`echo "unstaged" > unstaged.txt`.quiet().cwd(repoDir);

    const count = await getChangedFilesCount(repoDir);
    expect(count).toBe(2);

    // Cleanup
    await $`git reset HEAD staged.txt`.quiet().cwd(repoDir);
    await $`rm staged.txt unstaged.txt`.quiet().cwd(repoDir);
  });

  test("returns 0 for invalid path", async () => {
    const count = await getChangedFilesCount("/nonexistent/path");
    expect(count).toBe(0);
  });
});

describe("getCommitsBehind", () => {
  let repoDir: string;
  let worktreeDir: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "wct-status-behind-"));
    worktreeDir = await mkdtemp(join(tmpdir(), "wct-status-wt-"));

    await $`git init -b main`.quiet().cwd(repoDir);
    await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
    await $`git config user.name "Test"`.quiet().cwd(repoDir);
    await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
    await $`git commit --allow-empty -m "initial commit"`.quiet().cwd(repoDir);

    // Create a feature branch worktree
    const wtPath = join(worktreeDir, "feature-branch");
    await $`git worktree add -b feature-branch ${wtPath}`.quiet().cwd(repoDir);

    // Add commits to main after the branch was created
    await $`git commit --allow-empty -m "main commit 1"`.quiet().cwd(repoDir);
    await $`git commit --allow-empty -m "main commit 2"`.quiet().cwd(repoDir);
  });

  afterAll(async () => {
    // Remove worktree before deleting directories
    await $`git worktree remove --force ${join(worktreeDir, "feature-branch")}`
      .quiet()
      .cwd(repoDir)
      .nothrow();
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeDir, { recursive: true, force: true });
  });

  test("counts commits behind default branch", async () => {
    const wtPath = join(worktreeDir, "feature-branch");
    const count = await getCommitsBehind(wtPath, "main");
    expect(count).toBe(2);
  });

  test("returns 0 for main branch itself", async () => {
    const count = await getCommitsBehind(repoDir, "main");
    expect(count).toBe(0);
  });

  test("returns 0 for invalid path", async () => {
    const count = await getCommitsBehind("/nonexistent/path", "main");
    expect(count).toBe(0);
  });
});

describe("getDefaultBranch", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "wct-status-default-"));
    await $`git init -b main`.quiet().cwd(repoDir);
    await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
    await $`git config user.name "Test"`.quiet().cwd(repoDir);
    await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
    await $`git commit --allow-empty -m "initial commit"`.quiet().cwd(repoDir);
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  test("detects main branch via fallback", async () => {
    const branch = await getDefaultBranch(repoDir);
    expect(branch).toBe("main");
  });

  test("detects master branch via fallback", async () => {
    const masterRepoDir = await mkdtemp(join(tmpdir(), "wct-status-master-"));
    await $`git init -b master`.quiet().cwd(masterRepoDir);
    await $`git config user.email "test@test.com"`.quiet().cwd(masterRepoDir);
    await $`git config user.name "Test"`.quiet().cwd(masterRepoDir);
    await $`git config commit.gpgSign false`.quiet().cwd(masterRepoDir);
    await $`git commit --allow-empty -m "initial commit"`
      .quiet()
      .cwd(masterRepoDir);

    const branch = await getDefaultBranch(masterRepoDir);
    expect(branch).toBe("master");

    await rm(masterRepoDir, { recursive: true, force: true });
  });
});

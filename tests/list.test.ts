import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  getAheadBehind,
  getChangedFilesCount,
  getDefaultBranch,
  listCommand,
} from "../src/commands/list";

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

describe("getAheadBehind", () => {
  let repoDir: string;
  let worktreeDir: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "wct-status-sync-"));
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

    // Add a commit on the feature branch (ahead of main)
    await $`git commit --allow-empty -m "feature commit 1"`.quiet().cwd(wtPath);
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

  test("counts commits ahead and behind default branch", async () => {
    const wtPath = join(worktreeDir, "feature-branch");
    const { ahead, behind } = await getAheadBehind(wtPath, "main");
    expect(ahead).toBe(1);
    expect(behind).toBe(2);
  });

  test("returns zeros for main branch itself", async () => {
    const { ahead, behind } = await getAheadBehind(repoDir, "main");
    expect(ahead).toBe(0);
    expect(behind).toBe(0);
  });

  test("returns zeros for invalid path", async () => {
    const { ahead, behind } = await getAheadBehind("/nonexistent/path", "main");
    expect(ahead).toBe(0);
    expect(behind).toBe(0);
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

// Strip ANSI escape codes for test assertions
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are control characters by definition
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

describe("listCommand integration", () => {
  let repoDir: string;
  let worktreeDir: string;
  const originalDir = process.cwd();

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "wct-status-int-"));
    worktreeDir = await mkdtemp(join(tmpdir(), "wct-status-int-wt-"));

    await $`git init -b main`.quiet().cwd(repoDir);
    await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
    await $`git config user.name "Test"`.quiet().cwd(repoDir);
    await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
    await $`git commit --allow-empty -m "initial commit"`.quiet().cwd(repoDir);

    // Create a secondary worktree
    const wtPath = join(worktreeDir, "feature-test");
    await $`git worktree add -b feature-test ${wtPath}`.quiet().cwd(repoDir);

    // Add commits to main so the worktree is behind
    await $`git commit --allow-empty -m "main advance 1"`.quiet().cwd(repoDir);
    await $`git commit --allow-empty -m "main advance 2"`.quiet().cwd(repoDir);
    await $`git commit --allow-empty -m "main advance 3"`.quiet().cwd(repoDir);

    // Create staged and unstaged changes in the worktree
    await $`echo "staged content" > staged.txt`.quiet().cwd(wtPath);
    await $`git add staged.txt`.quiet().cwd(wtPath);
    await $`echo "unstaged content" > unstaged.txt`.quiet().cwd(wtPath);
  });

  afterAll(async () => {
    process.chdir(originalDir);
    await $`git worktree remove --force ${join(worktreeDir, "feature-test")}`
      .quiet()
      .cwd(repoDir)
      .nothrow();
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeDir, { recursive: true, force: true });
  });

  test("prints header and worktree rows with correct data", async () => {
    process.chdir(repoDir);

    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation(
      (...args: unknown[]) => {
        lines.push(String(args[0]));
      },
    );

    const result = await listCommand();

    spy.mockRestore();
    process.chdir(originalDir);

    expect(result.success).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // Verify header row contains all column headers
    const header = stripAnsi(lines[0] ?? "");
    expect(header).toContain("BRANCH");
    expect(header).toContain("PATH");
    expect(header).toContain("TMUX");
    expect(header).toContain("CHANGES");
    expect(header).toContain("SYNC");

    // Verify the feature worktree row
    const dataLines = lines.slice(1).map(stripAnsi);
    const featureRow = dataLines.find((l) => l.includes("feature-test"));
    expect(featureRow).toBeDefined();
    expect(featureRow).toContain("2 files");
    expect(featureRow).toContain("\u21933");
  });

  test("short mode prints only branch names", async () => {
    process.chdir(repoDir);

    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation(
      (...args: unknown[]) => {
        lines.push(String(args[0]));
      },
    );

    const result = await listCommand({ short: true });

    spy.mockRestore();
    process.chdir(originalDir);

    expect(result.success).toBe(true);
    // Should have branch names only, no header
    expect(lines.some((l) => l.includes("BRANCH"))).toBe(false);
    expect(lines.some((l) => l.includes("main"))).toBe(true);
    expect(lines.some((l) => l.includes("feature-test"))).toBe(true);
  });

  test("shows main worktree when no secondary worktrees exist", async () => {
    const emptyRepo = await mkdtemp(join(tmpdir(), "wct-list-single-"));
    await $`git init -b main`.quiet().cwd(emptyRepo);
    await $`git config user.email "test@test.com"`.quiet().cwd(emptyRepo);
    await $`git config user.name "Test"`.quiet().cwd(emptyRepo);
    await $`git config commit.gpgSign false`.quiet().cwd(emptyRepo);
    await $`git commit --allow-empty -m "initial"`.quiet().cwd(emptyRepo);

    process.chdir(emptyRepo);

    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation(
      (...args: unknown[]) => {
        lines.push(String(args[0]));
      },
    );

    const result = await listCommand();

    spy.mockRestore();
    process.chdir(originalDir);

    expect(result.success).toBe(true);
    // Should show the main worktree row
    const dataLines = lines.slice(1).map(stripAnsi);
    expect(dataLines.some((l) => l.includes("main"))).toBe(true);

    await rm(emptyRepo, { recursive: true, force: true });
  });
});

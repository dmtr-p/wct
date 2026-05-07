import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  projectsAddCommand,
  projectsRemoveCommand,
} from "../src/commands/projects";
import { runBunPromise } from "../src/effect/runtime";
import { runMigrations } from "../src/services/db";
import {
  livePrCacheService,
  PrCacheService,
  sqlGetCached,
  sqlSetCached,
} from "../src/services/pr-cache-service";
import {
  liveRegistryService,
  RegistryService,
} from "../src/services/registry-service";
import type { PRInfo } from "../src/tui/types";
import { withTestServices } from "./helpers/services";

const CLI_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function runCliProcess(args: string[], cwd?: string) {
  return Bun.spawnSync(["bun", "run", CLI_ENTRY, ...args], {
    cwd,
    env: {
      ...process.env,
    },
  });
}

function runProcess(cmd: string[], cwd: string) {
  return Bun.spawnSync(cmd, { cwd });
}

const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "g",
);

function stripAnsi(value: string) {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

describe("projects command", () => {
  let tempDir: string;
  let repoDir: string;
  let resolvedRepoDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `wct-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    repoDir = join(tempDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    resolvedRepoDir = realpathSync(repoDir);
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const initResult = runProcess(["git", "init", "-b", "main"], repoDir);
    expect(initResult.exitCode).toBe(0);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("projects list --json returns an empty success envelope when registry is empty", () => {
    const result = runCliProcess(["projects", "list", "--json"]);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      data: [],
    });
  });

  test("projects list prints a human-readable empty state when registry is empty", () => {
    const result = runCliProcess(["projects", "list"]);
    const stdout = stripAnsi(result.stdout.toString());

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(stdout).toContain("No projects registered");
  });

  test("global --json before projects list returns the same empty success envelope", () => {
    const result = runCliProcess(["--json", "projects", "list"]);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      data: [],
    });
  });

  test("projects add --json returns the registered registry item envelope", () => {
    const result = runCliProcess([
      "projects",
      "add",
      repoDir,
      "--name",
      "example-project",
      "--json",
    ]);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      data: expect.objectContaining({
        repo_path: resolvedRepoDir,
        project: "example-project",
        id: expect.any(String),
        created_at: expect.any(Number),
      }),
    });

    const listResult = runCliProcess(["projects", "list", "--json"]);

    expect(listResult.exitCode).toBe(0);
    expect(listResult.stderr.toString()).toBe("");
    expect(JSON.parse(listResult.stdout.toString())).toEqual({
      ok: true,
      data: [
        expect.objectContaining({
          repo_path: resolvedRepoDir,
          project: "example-project",
        }),
      ],
    });
  });

  test("projects add prints a human-readable success message", () => {
    const result = runCliProcess([
      "projects",
      "add",
      repoDir,
      "--name",
      "example-project",
    ]);
    const stdout = stripAnsi(result.stdout.toString());

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(stdout).toContain(`Added ${resolvedRepoDir} as 'example-project'`);
  });

  test("projects remove --json returns removed metadata for the repo path", () => {
    const addResult = runCliProcess([
      "projects",
      "add",
      repoDir,
      "--name",
      "example-project",
      "--json",
    ]);

    expect(addResult.exitCode).toBe(0);

    const result = runCliProcess(["projects", "remove", repoDir, "--json"]);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      data: {
        repo_path: resolvedRepoDir,
        removed: true,
      },
    });

    const listResult = runCliProcess(["projects", "list", "--json"]);

    expect(listResult.exitCode).toBe(0);
    expect(listResult.stderr.toString()).toBe("");
    expect(JSON.parse(listResult.stdout.toString())).toEqual({
      ok: true,
      data: [],
    });
  });

  test("projects remove prints a human-readable success message", () => {
    const addResult = runCliProcess([
      "projects",
      "add",
      repoDir,
      "--name",
      "example-project",
      "--json",
    ]);

    expect(addResult.exitCode).toBe(0);

    const result = runCliProcess(["projects", "remove", repoDir]);
    const stdout = stripAnsi(result.stdout.toString());

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(stdout).toContain(`Removed ${resolvedRepoDir}`);
  });

  test("global --json projects remove returns a JSON error when the repo is unregistered", () => {
    const result = runCliProcess(["--json", "projects", "remove", repoDir]);
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
    expect(() => JSON.parse(stderr)).not.toThrow();
    expect(JSON.parse(stderr)).toEqual({
      ok: false,
      error: {
        code: "registry_error",
        message: `Project not found in registry: ${resolvedRepoDir}`,
      },
    });
  });

  test("projects add and remove use process.cwd() when no repo path is provided", () => {
    const addResult = runCliProcess(
      ["--json", "projects", "add", "--name", "cwd-project"],
      repoDir,
    );

    expect(addResult.exitCode).toBe(0);
    expect(addResult.stderr.toString()).toBe("");
    expect(JSON.parse(addResult.stdout.toString())).toEqual({
      ok: true,
      data: expect.objectContaining({
        repo_path: resolvedRepoDir,
        project: "cwd-project",
      }),
    });

    const listAfterAdd = runCliProcess(["--json", "projects", "list"]);

    expect(listAfterAdd.exitCode).toBe(0);
    expect(listAfterAdd.stderr.toString()).toBe("");
    expect(JSON.parse(listAfterAdd.stdout.toString())).toEqual({
      ok: true,
      data: [
        expect.objectContaining({
          repo_path: resolvedRepoDir,
          project: "cwd-project",
        }),
      ],
    });

    const removeResult = runCliProcess(
      ["--json", "projects", "remove"],
      repoDir,
    );

    expect(removeResult.exitCode).toBe(0);
    expect(removeResult.stderr.toString()).toBe("");
    expect(JSON.parse(removeResult.stdout.toString())).toEqual({
      ok: true,
      data: {
        repo_path: resolvedRepoDir,
        removed: true,
      },
    });

    const listAfterRemove = runCliProcess(["--json", "projects", "list"]);

    expect(listAfterRemove.exitCode).toBe(0);
    expect(listAfterRemove.stderr.toString()).toBe("");
    expect(JSON.parse(listAfterRemove.stdout.toString())).toEqual({
      ok: true,
      data: [],
    });
  });

  test("projects list prints a populated table with headers and the registered row", () => {
    const addResult = runCliProcess([
      "projects",
      "add",
      repoDir,
      "--name",
      "example-project",
      "--json",
    ]);

    expect(addResult.exitCode).toBe(0);

    const result = runCliProcess(["projects", "list"]);
    const stdoutLines = stripAnsi(result.stdout.toString())
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(stdoutLines.length).toBeGreaterThanOrEqual(2);
    expect(stdoutLines[0]).toContain("PROJECT");
    expect(stdoutLines[0]).toContain("PATH");
    expect(
      stdoutLines.some(
        (line) =>
          line.includes("example-project") && line.includes(resolvedRepoDir),
      ),
    ).toBe(true);
  });

  test("projects add --json returns an invalid_options error for an invalid path", () => {
    const badPath = join(tempDir, "missing-project-repo");

    const result = runCliProcess(["--json", "projects", "add", badPath]);
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
    expect(() => JSON.parse(stderr)).not.toThrow();
    expect(JSON.parse(stderr)).toEqual({
      ok: false,
      error: {
        code: "invalid_options",
        message: `Invalid path: ${badPath}`,
      },
    });
  });

  test("projects add --json returns not_git_repo for an existing non-git directory", () => {
    const nonGitDir = join(tempDir, "plain-directory");
    mkdirSync(nonGitDir, { recursive: true });
    const resolvedNonGitDir = resolve(nonGitDir);

    const result = runCliProcess(["--json", "projects", "add", nonGitDir]);
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
    expect(() => JSON.parse(stderr)).not.toThrow();
    expect(JSON.parse(stderr)).toEqual({
      ok: false,
      error: {
        code: "not_git_repo",
        message: `Not a git repository: ${resolvedNonGitDir}`,
      },
    });
  });

  test("projects remove --json returns an invalid_options error for an invalid path", () => {
    const badPath = join(tempDir, "missing-project-repo");

    const result = runCliProcess(["--json", "projects", "remove", badPath]);
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stdout.trim()).toBe("");
    expect(() => JSON.parse(stderr)).not.toThrow();
    expect(JSON.parse(stderr)).toEqual({
      ok: false,
      error: {
        code: "invalid_options",
        message: `Invalid path: ${badPath}`,
      },
    });
  });

  test("projects add falls back to basename when config is malformed", () => {
    writeFileSync(join(repoDir, ".wct.yaml"), "project_name: [\n");

    const result = runCliProcess(["--json", "projects", "add", repoDir]);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      data: expect.objectContaining({
        repo_path: resolvedRepoDir,
        project: "repo",
      }),
    });
  });

  test("projectsAddCommand fails with worktree_error when process.cwd() throws", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd unavailable");
    });

    try {
      await expect(
        runBunPromise(withTestServices(projectsAddCommand())),
      ).rejects.toMatchObject({
        code: "worktree_error",
        details: "Could not determine current directory",
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test("projectsRemoveCommand fails with worktree_error when process.cwd() throws", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd unavailable");
    });

    try {
      await expect(
        runBunPromise(withTestServices(projectsRemoveCommand())),
      ).rejects.toMatchObject({
        code: "worktree_error",
        details: "Could not determine current directory",
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test("projectsRemoveCommand clears pr_cache row for the removed project", async () => {
    // Seed registry and pr_cache using live services pointing at the temp HOME
    // (process.env.HOME = tempDir is set by beforeEach above)
    const addResult = runCliProcess([
      "projects",
      "add",
      repoDir,
      "--name",
      "cache-test-project",
      "--json",
    ]);
    expect(addResult.exitCode).toBe(0);

    // Manually seed a pr_cache row for the project using the same on-disk DB
    const dbPath = `${tempDir}/.wct/wct.db`;
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode=WAL");
    const prA: PRInfo = {
      number: 42,
      title: "feat: cached pr",
      state: "OPEN",
      headRefName: "feat/cached",
      rollupState: "success",
    };
    sqlSetCached(db, "cache-test-project", [prA]);

    // Verify the cache row exists before removal
    const beforeRemove = sqlGetCached(db, "cache-test-project");
    expect(beforeRemove).not.toBeNull();
    expect(beforeRemove!.payload).toEqual([prA]);
    db.close();

    // Run projectsRemoveCommand via the live CLI process
    const removeResult = runCliProcess([
      "projects",
      "remove",
      repoDir,
      "--json",
    ]);
    expect(removeResult.exitCode).toBe(0);
    expect(JSON.parse(removeResult.stdout.toString())).toEqual({
      ok: true,
      data: { repo_path: resolvedRepoDir, removed: true },
    });

    // Assert the pr_cache row is gone
    const db2 = new Database(dbPath);
    db2.run("PRAGMA journal_mode=WAL");
    const afterRemove = sqlGetCached(db2, "cache-test-project");
    expect(afterRemove).toBeNull();
    db2.close();
  });

  test("projects --help shows add, remove, and list subcommands", () => {
    const result = runCliProcess(["projects", "--help"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(output).toContain("add");
    expect(output).toContain("remove");
    expect(output).toContain("list");
  });
});

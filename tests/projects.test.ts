import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

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

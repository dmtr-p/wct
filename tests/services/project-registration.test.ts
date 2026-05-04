import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";
import { runBunPromise } from "../../src/effect/runtime";
import { registerProject } from "../../src/services/project-registration";
import type {
  RegistryItem,
  RegistryServiceApi,
} from "../../src/services/registry-service";
import type { WorktreeService } from "../../src/services/worktree-service";
import { withTestServices } from "../helpers/services";

function fakeRegistry(calls: Array<{ path: string; project: string }>) {
  return {
    register: (repoPath: string, project: string) =>
      Effect.sync(() => {
        calls.push({ path: repoPath, project });
        return {
          id: "registry-item",
          repo_path: repoPath,
          project,
          created_at: 1,
        } satisfies RegistryItem;
      }),
    unregister: () => Effect.succeed(false),
    listRepos: () => Effect.succeed([]),
    findByPath: () => Effect.succeed(null),
  } satisfies RegistryServiceApi;
}

function fakeWorktree(mainRepoPath: string | null) {
  return {
    getMainRepoPath: () => Effect.succeed(mainRepoPath),
  } as Partial<WorktreeService> as WorktreeService;
}

function tempPath(label: string) {
  return join(
    tmpdir(),
    `wct-project-registration-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

describe("project registration", () => {
  test("uses an explicit project name when one is provided", async () => {
    const tempDir = tempPath("explicit");
    mkdirSync(tempDir, { recursive: true });
    const calls: Array<{ path: string; project: string }> = [];

    try {
      const result = await runBunPromise(
        withTestServices(
          registerProject({ path: tempDir, name: "explicit-name" }),
          {
            registry: fakeRegistry(calls),
            worktree: fakeWorktree(tempDir),
          },
        ),
      );

      expect(result.projectName).toBe("explicit-name");
      expect(result.repoPath).toBe(tempDir);
      expect(calls).toEqual([{ path: tempDir, project: "explicit-name" }]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("derives the project name from config before falling back to basename", async () => {
    const tempDir = tempPath("config");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, ".wct.yaml"), 'project_name: "from-config"\n');
    const calls: Array<{ path: string; project: string }> = [];

    try {
      const result = await runBunPromise(
        withTestServices(registerProject({ path: tempDir }), {
          registry: fakeRegistry(calls),
          worktree: fakeWorktree(tempDir),
        }),
      );

      expect(result.projectName).toBe("from-config");
      expect(calls).toEqual([{ path: tempDir, project: "from-config" }]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("falls back to basename when config loading is allowed to fail", async () => {
    const tempDir = tempPath("malformed-config");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, ".wct.yaml"), "project_name: [\n");
    const calls: Array<{ path: string; project: string }> = [];

    try {
      const result = await runBunPromise(
        withTestServices(
          registerProject({ path: tempDir, tolerateConfigErrors: true }),
          {
            registry: fakeRegistry(calls),
            worktree: fakeWorktree(tempDir),
          },
        ),
      );

      expect(result.projectName).toBe(basename(tempDir));
      expect(calls).toEqual([{ path: tempDir, project: basename(tempDir) }]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("surfaces config errors when config loading must succeed", async () => {
    const tempDir = tempPath("strict-config");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, ".wct.yaml"), "project_name: [\n");

    try {
      await expect(
        runBunPromise(
          withTestServices(registerProject({ path: tempDir }), {
            registry: fakeRegistry([]),
            worktree: fakeWorktree(tempDir),
          }),
        ),
      ).rejects.toMatchObject({
        code: "config_error",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns invalid_options for a missing explicit path", async () => {
    const missingPath = tempPath("missing");

    await expect(
      runBunPromise(
        withTestServices(registerProject({ path: missingPath }), {
          registry: fakeRegistry([]),
          worktree: fakeWorktree(null),
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_options",
      details: `Invalid path: ${missingPath}`,
    });
  });

  test("returns not_git_repo when the path exists but has no main repo", async () => {
    const tempDir = tempPath("not-git");
    mkdirSync(tempDir, { recursive: true });

    try {
      await expect(
        runBunPromise(
          withTestServices(registerProject({ path: tempDir }), {
            registry: fakeRegistry([]),
            worktree: fakeWorktree(null),
          }),
        ),
      ).rejects.toMatchObject({
        code: "not_git_repo",
        details: `Not a git repository: ${tempDir}`,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns worktree_error when process.cwd cannot be resolved", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd unavailable");
    });

    try {
      await expect(
        runBunPromise(
          withTestServices(registerProject(), {
            registry: fakeRegistry([]),
            worktree: fakeWorktree(null),
          }),
        ),
      ).rejects.toMatchObject({
        code: "worktree_error",
        details: "Could not determine current directory",
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test("returns worktree_error for relative paths when process.cwd cannot be resolved", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd unavailable");
    });

    try {
      await expect(
        runBunPromise(
          withTestServices(registerProject({ path: "relative-repo" }), {
            registry: fakeRegistry([]),
            worktree: fakeWorktree(null),
          }),
        ),
      ).rejects.toMatchObject({
        code: "worktree_error",
        details: "Could not determine current directory",
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, vi } from "vitest";
import * as processService from "../../src/services/process";
import { test as databaseTest } from "./database";
import { test as repoTest } from "./include-repo";

function environment() {
  return {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
}

interface FinishedTest {
  name: string;
  environmentBefore: ReturnType<typeof environment>;
  environmentAfter: ReturnType<typeof environment>;
  errors: (string | undefined)[];
  expectedErrors: string[];
}

describe("resource fixture cleanup", { concurrent: false }, () => {
  const directories: string[] = [];
  const databases: Database[] = [];
  const finishedTests: FinishedTest[] = [];
  const setupFailureName =
    "releases resources when Git setup fails before the test body";

  beforeEach(({ task, onTestFinished }) => {
    const environmentBefore = environment();
    onTestFinished(() => {
      finishedTests.push({
        name: task.name,
        environmentBefore,
        environmentAfter: environment(),
        errors: task.result?.errors?.map((error) => error.message) ?? [],
        expectedErrors: task.fails
          ? [
              task.name === setupFailureName
                ? "Git setup failed"
                : "fixture consumer assertion failed",
            ]
          : [],
      });
    });
  });

  // Expected-failure tests also accept teardown errors. Check cleanup and the
  // original failure separately so a cleanup error cannot make these tests pass.
  afterAll(async () => {
    for (const result of finishedTests) {
      expect(result.errors, result.name).toEqual(result.expectedErrors);
      expect(result.environmentAfter, result.name).toEqual(
        result.environmentBefore,
      );
    }
    expect(new Set(directories).size).toBe(directories.length);
    for (const directory of directories) {
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(new Set(databases).size).toBe(databases.length);
    for (const db of databases) {
      expect(() => db.query("SELECT 1").get()).toThrow();
    }
  });

  for (const fail of [false, true]) {
    repoTest(
      `removes repository files and restores environment (assertion failure: ${fail})`,
      { fails: fail },
      async ({ includeRepo }) => {
        directories.push(includeRepo.root);
        expect(environment()).toEqual({
          HOME: includeRepo.home,
          XDG_CONFIG_HOME: join(includeRepo.home, ".config"),
          GIT_CONFIG_GLOBAL: join(includeRepo.home, ".gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
        });
        expect(
          await Bun.file(join(includeRepo.repo, "tracked.txt")).text(),
        ).toBe("tracked.txt");
        await includeRepo.git(
          "worktree",
          "add",
          "-b",
          "linked",
          join(includeRepo.root, "linked"),
        );
        if (fail) expect.fail("fixture consumer assertion failed");
      },
    );

    databaseTest(
      `closes a fresh empty database (assertion failure: ${fail})`,
      { fails: fail },
      ({ db }) => {
        databases.push(db);
        expect(db.query("SELECT name FROM sqlite_master").all()).toEqual([]);
        db.run("CREATE TABLE scenario (value TEXT)");
        if (fail) expect.fail("fixture consumer assertion failed");
      },
    );
  }

  const setupFailureTest = repoTest.extend<{ tempDir: string }>({
    tempDir: async ({ tempDir }, use) => {
      directories.push(tempDir);
      const git = vi
        .spyOn(processService, "execProcess")
        .mockImplementation((command, args, options) => {
          expect(command).toBe("git");
          expect(args).toEqual([
            "init",
            "--quiet",
            "--template=",
            "--initial-branch=main",
          ]);
          expect(options?.cwd).toBe(join(tempDir, "repo"));
          expect(environment()).toEqual({
            HOME: join(tempDir, "home"),
            XDG_CONFIG_HOME: join(tempDir, "home", ".config"),
            GIT_CONFIG_GLOBAL: join(tempDir, "home", ".gitconfig"),
            GIT_CONFIG_NOSYSTEM: "1",
          });
          throw new Error("Git setup failed");
        });
      try {
        await use(tempDir);
      } finally {
        git.mockRestore();
      }
    },
  });

  setupFailureTest(setupFailureName, { fails: true }, ({ includeRepo }) => {
    expect.fail(
      `Test body must not run after Git setup fails: ${includeRepo.repo}`,
    );
  });
});

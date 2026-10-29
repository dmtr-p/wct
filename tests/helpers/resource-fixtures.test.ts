import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import * as processService from "../../src/services/process";
import { databaseFixture } from "./database";
import { includeRepoFixture } from "./include-repo";
import { tempDirFixture } from "./temp-dir";

function environment() {
  return {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
}

describe("resource fixture cleanup", { concurrent: false }, () => {
  test.each([false, true])(
    "removes repository files and restores environment (assertion failure: %s)",
    async (fail) => {
      const originalEnvironment = environment();
      let directory = "";
      const lifetime = tempDirFixture({}, async (tempDir) => {
        directory = tempDir;
        await includeRepoFixture({ tempDir }, async (repo) => {
          expect(environment()).toEqual({
            HOME: repo.home,
            XDG_CONFIG_HOME: join(repo.home, ".config"),
            GIT_CONFIG_GLOBAL: join(repo.home, ".gitconfig"),
            GIT_CONFIG_NOSYSTEM: "1",
          });
          expect(await Bun.file(join(repo.repo, "tracked.txt")).text()).toBe(
            "tracked.txt",
          );
          await repo.git(
            "worktree",
            "add",
            "-b",
            "linked",
            join(repo.root, "linked"),
          );
          if (fail) expect.fail("fixture consumer assertion failed");
        });
      });

      if (fail) {
        await expect(lifetime).rejects.toThrow(
          "fixture consumer assertion failed",
        );
      } else {
        await lifetime;
      }

      expect(directory).not.toBe("");
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(environment()).toEqual(originalEnvironment);
    },
  );

  test("releases the directory and environment when Git setup fails before use", async ({
    onTestFinished,
  }) => {
    const originalEnvironment = environment();
    const failure = new Error("Git setup failed");
    const git = vi
      .spyOn(processService, "execProcess")
      .mockImplementation(() => {
        expect(process.env.HOME).not.toBe(originalEnvironment.HOME);
        throw failure;
      });
    onTestFinished(() => {
      git.mockRestore();
    });
    const use = vi.fn();
    let directory = "";

    await expect(
      tempDirFixture({}, async (tempDir) => {
        directory = tempDir;
        await includeRepoFixture({ tempDir }, use);
      }),
    ).rejects.toBe(failure);

    expect(git).toHaveBeenCalledExactlyOnceWith(
      "git",
      ["init", "--quiet", "--template=", "--initial-branch=main"],
      { cwd: join(directory, "repo") },
    );
    expect(use).not.toHaveBeenCalled();
    expect(directory).not.toBe("");
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(environment()).toEqual(originalEnvironment);
  });

  test.each([false, true])(
    "closes fresh empty databases (assertion failure: %s)",
    async (fail) => {
      const databases: Database[] = [];
      for (let index = 0; index < 2; index++) {
        const lifetime = databaseFixture({}, async (db) => {
          databases.push(db);
          expect(db.query("SELECT name FROM sqlite_master").all()).toEqual([]);
          db.run("CREATE TABLE scenario (value TEXT)");
          if (fail) expect.fail("fixture consumer assertion failed");
        });
        if (fail) {
          await expect(lifetime).rejects.toThrow(
            "fixture consumer assertion failed",
          );
        } else {
          await lifetime;
        }
      }

      expect(databases).toHaveLength(2);
      expect(databases[0]).not.toBe(databases[1]);
      for (const db of databases) {
        expect(() => db.query("SELECT 1").get()).toThrow();
      }
    },
  );
});

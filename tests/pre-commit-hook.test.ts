import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const hook = new URL("../.githooks/pre-commit", import.meta.url);

describe("Git pre-commit hook", () => {
  let root: string;
  let repo: string;
  let foreign: string;
  let env: Record<string, string | undefined>;

  function git(cwd: string, ...args: string[]) {
    return Bun.spawnSync(["git", ...args], { cwd, env, stdin: "ignore" });
  }

  function succeed(cwd: string, ...args: string[]) {
    const result = git(cwd, ...args);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "wct-pre-commit-"));
    repo = join(root, "repo");
    foreign = join(root, "foreign");
    await mkdir(repo);
    await mkdir(join(root, "bin"));
    env = { ...process.env };
    const localVariables = Bun.spawnSync([
      "git",
      "rev-parse",
      "--local-env-vars",
    ]);
    expect(localVariables.exitCode).toBe(0);
    for (const name of localVariables.stdout.toString().trim().split("\n"))
      delete env[name];
    Object.assign(env, {
      GIT_AUTHOR_NAME: "Hook Test",
      GIT_AUTHOR_EMAIL: "hook@example.test",
      GIT_COMMITTER_NAME: "Hook Test",
      GIT_COMMITTER_EMAIL: "hook@example.test",
      WCT_HOOK_FOREIGN: foreign,
      WCT_HOOK_EXIT: "0",
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
    });
    succeed(repo, "init", "-q");
    succeed(
      repo,
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-qm",
      "seed",
    );
    const foreignMain = join(root, "foreign-main");
    await mkdir(foreignMain);
    succeed(foreignMain, "init", "-q");
    succeed(foreignMain, "config", "core.hooksPath", "/dev/null");
    succeed(foreignMain, "commit", "--allow-empty", "-qm", "seed");
    succeed(foreignMain, "worktree", "add", "-qb", "foreign", foreign);
    // A leaked command-line hooksPath would override this repo's own config.
    await mkdir(join(foreign, ".githooks"));
    await Bun.write(
      join(foreign, ".githooks", "pre-commit"),
      "#!/bin/sh\nexit 99\n",
    );
    await chmod(join(foreign, ".githooks", "pre-commit"), 0o755);
    await Bun.write(join(foreign, "result.txt"), "foreign change\n");
    await mkdir(join(repo, ".githooks"));
    await Bun.write(
      join(repo, ".githooks", "pre-commit"),
      await Bun.file(hook).text(),
    );
    await chmod(join(repo, ".githooks", "pre-commit"), 0o755);
    succeed(repo, "config", "core.hooksPath", ".githooks");
    await Bun.write(
      join(root, "bin", "mise"),
      `#!/bin/sh
set -eu
[ "$*" = "run pre-commit" ]
# A linked worktree has a .git file, exposing a leaked relative index path.
git -C "$WCT_HOOK_FOREIGN" add result.txt
git -C "$WCT_HOOK_FOREIGN" commit -qm "foreign commit"
exit "$WCT_HOOK_EXIT"
`,
    );
    await chmod(join(root, "bin", "mise"), 0o755);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test.each(["main", "linked", "alternate index"])(
    "isolates checks during a real commit from %s",
    async (kind) => {
      let cwd = repo;
      if (kind === "linked") {
        cwd = join(root, "linked");
        succeed(repo, "worktree", "add", "-qb", "linked", cwd);
        await mkdir(join(cwd, ".githooks"));
        await Bun.write(
          join(cwd, ".githooks", "pre-commit"),
          await Bun.file(hook).text(),
        );
        await chmod(join(cwd, ".githooks", "pre-commit"), 0o755);
      }
      if (kind === "alternate index") env.GIT_INDEX_FILE = join(root, "index");
      await Bun.write(join(cwd, "change.txt"), "committed change\n");
      succeed(cwd, "add", "change.txt");
      // A command-line hooks override must not install this hook in fixtures.
      succeed(cwd, "-c", "core.hooksPath=.githooks", "commit", "-qm", "change");
      delete env.GIT_INDEX_FILE;
      expect(succeed(cwd, "show", "HEAD:change.txt")).toBe("committed change");
      expect(succeed(foreign, "show", "HEAD:result.txt")).toBe(
        "foreign change",
      );
      expect(git(cwd, "cat-file", "-e", "HEAD:result.txt").exitCode).not.toBe(
        0,
      );
      if (kind === "alternate index")
        expect(
          git(cwd, "ls-files", "--error-unmatch", "change.txt").exitCode,
        ).not.toBe(0);
    },
  );

  test("failed verification rejects the commit", () => {
    env.WCT_HOOK_EXIT = "1";
    const before = succeed(repo, "rev-parse", "HEAD");
    expect(
      git(repo, "commit", "--allow-empty", "-qm", "rejected").exitCode,
    ).not.toBe(0);
    expect(succeed(repo, "rev-parse", "HEAD")).toBe(before);
  });
});

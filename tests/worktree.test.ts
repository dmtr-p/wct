import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runBunPromise } from "../src/effect/runtime";
import { provideWctServices } from "../src/effect/services";
import { WorkspaceService } from "../src/services/workspace-service";
import {
  formatChanges,
  formatSync,
  liveWorktreeService,
  parseAheadBehind,
  parseGitStatusCount,
  parseWorktreeListOutput,
  WorktreeService,
} from "../src/services/worktree-service";
import { makeIncludeRepo } from "./helpers/include-repo";
import { noopTmuxService, withTestServices } from "./helpers/services";

function withWorktreeService<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return provideWctServices(effect);
}

describe("parseWorktreeListOutput", () => {
  test("parses porcelain output correctly", () => {
    const output = `worktree /home/user/projects/myapp
HEAD abc123def456
branch refs/heads/main

worktree /home/user/worktrees/myapp/feature-auth
HEAD def456abc123
branch refs/heads/feature-auth

worktree /home/user/worktrees/myapp/detached
HEAD 789abcdef012
detached
`;

    const worktrees = parseWorktreeListOutput(output);

    expect(worktrees).toHaveLength(3);

    expect(worktrees[0]?.path).toBe("/home/user/projects/myapp");
    expect(worktrees[0]?.branch).toBe("main");
    expect(worktrees[0]?.commit).toBe("abc123def456");

    expect(worktrees[1]?.path).toBe("/home/user/worktrees/myapp/feature-auth");
    expect(worktrees[1]?.branch).toBe("feature-auth");

    expect(worktrees[2]?.path).toBe("/home/user/worktrees/myapp/detached");
    expect(worktrees[2]?.branch).toBe("(detached)");
  });

  test("handles bare repository", () => {
    const output = `worktree /home/user/repos/myapp.git
bare
`;

    const worktrees = parseWorktreeListOutput(output);

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.isBare).toBe(true);
  });

  test("handles empty output", () => {
    const worktrees = parseWorktreeListOutput("");
    expect(worktrees).toHaveLength(0);
  });
});

describe("parseGitStatusCount", () => {
  test("counts lines", () => {
    expect(parseGitStatusCount(" M file1.ts\n M file2.ts\n?? file3.ts")).toBe(
      3,
    );
  });

  test("returns 0 for empty output", () => {
    expect(parseGitStatusCount("")).toBe(0);
    expect(parseGitStatusCount("  ")).toBe(0);
  });
});

describe("formatChanges", () => {
  test("returns singular for 1 file", () => {
    expect(formatChanges(1)).toBe("1 file");
  });

  test("returns plural for multiple files", () => {
    expect(formatChanges(3)).toBe("3 files");
  });
});

describe("parseAheadBehind", () => {
  test("parses ahead/behind counts", () => {
    expect(parseAheadBehind("3\t5")).toEqual({ ahead: 3, behind: 5 });
  });

  test("handles zero counts", () => {
    expect(parseAheadBehind("0\t0")).toEqual({ ahead: 0, behind: 0 });
  });

  test("returns null for invalid output", () => {
    expect(parseAheadBehind("")).toBeNull();
  });
});

describe("formatSync", () => {
  test("returns checkmark when in sync", () => {
    expect(formatSync({ ahead: 0, behind: 0 })).toBe("\u2713");
  });

  test("returns up arrow with count when ahead", () => {
    expect(formatSync({ ahead: 3, behind: 0 })).toBe("\u21913");
  });

  test("returns down arrow with count when behind", () => {
    expect(formatSync({ ahead: 0, behind: 2 })).toBe("\u21932");
  });

  test("returns both arrows when ahead and behind", () => {
    expect(formatSync({ ahead: 1, behind: 3 })).toBe("\u21911 \u21933");
  });

  test("returns ? when sync is null", () => {
    expect(formatSync(null)).toBe("?");
  });
});

describe("findWorktreeByBranch", () => {
  test("returns null when no worktrees exist", async () => {
    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) =>
          service.findWorktreeByBranch("nonexistent-branch-xyz"),
        ),
      ),
    );
    expect(result).toBeNull();
  });
});

describe("createWorktree with base branch", () => {
  let repoDir: string;
  let worktreeDir: string;
  const originalDir = process.cwd();

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "wct-test-repo-"));
    worktreeDir = await mkdtemp(join(tmpdir(), "wct-test-wt-"));

    process.chdir(repoDir);
    await $`git init -b main`.quiet().cwd(repoDir);
    await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
    await $`git config user.name "Test"`.quiet().cwd(repoDir);
    await $`git config commit.gpgSign false`.quiet().cwd(repoDir);

    await $`git commit --allow-empty -m "initial commit"`.quiet().cwd(repoDir);

    await $`git checkout -b develop`.quiet().cwd(repoDir);
    await $`git commit --allow-empty -m "develop commit"`.quiet().cwd(repoDir);

    await $`git checkout main`.quiet().cwd(repoDir);
  });

  afterAll(async () => {
    process.chdir(originalDir);
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeDir, { recursive: true, force: true });
  });

  test("closes a missing worktree without removing other stale records", async () => {
    const canonicalWorktreeDir = await realpath(worktreeDir);
    const missingPath = join(canonicalWorktreeDir, "missing-close");
    const otherPath = join(canonicalWorktreeDir, "other-missing-close");
    for (const [path, branch] of [
      [missingPath, "missing-close"],
      [otherPath, "other-missing-close"],
    ] as const) {
      await $`git worktree add -b ${branch} ${path}`.quiet().cwd(repoDir);
      await rm(path, { recursive: true });
    }

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.close({ path: missingPath, cwd: repoDir }),
        ),
        { tmux: noopTmuxService },
      ),
    );

    expect(result.status).toBe("removed");
    const remaining = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) => service.listWorktrees(repoDir)),
      ),
    );
    expect(remaining.some((wt) => wt.path === missingPath)).toBe(false);
    expect(remaining.some((wt) => wt.path === otherPath)).toBe(true);
    await $`git worktree remove ${otherPath}`.quiet().cwd(repoDir);
  });

  test("rejects closing an unregistered missing path", async () => {
    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.close({
              path: join(worktreeDir, "never-registered"),
              cwd: repoDir,
            }),
          ),
          { tmux: noopTmuxService },
        ),
      ),
    ).rejects.toThrow("Not a git repository");
  });

  test("creates worktree with base branch", async () => {
    process.chdir(repoDir);
    const wtPath = join(worktreeDir, "feature-from-develop");
    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) =>
          service.createWorktree(
            wtPath,
            "feature-from-develop",
            false,
            "develop",
          ),
        ),
      ),
    );

    expect(result._tag).toBe("Created");
    expect(result.path).toBe(wtPath);

    const log = await $`git log --oneline feature-from-develop`
      .quiet()
      .cwd(repoDir);
    const logText = log.text();
    expect(logText).toContain("develop commit");
  });

  test("creates worktree without base (defaults to HEAD)", async () => {
    process.chdir(repoDir);
    const wtPath = join(worktreeDir, "feature-from-head");
    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) =>
          service.createWorktree(wtPath, "feature-from-head", false),
        ),
      ),
    );

    expect(result._tag).toBe("Created");

    const log = await $`git log --oneline feature-from-head`
      .quiet()
      .cwd(repoDir);
    const logText = log.text();
    expect(logText).not.toContain("develop commit");
  });

  test("creates worktree using explicit cwd without relying on process cwd", async () => {
    process.chdir(originalDir);
    const wtPath = join(worktreeDir, "feature-from-explicit-cwd");
    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) =>
          service.createWorktree(
            wtPath,
            "feature-from-explicit-cwd",
            false,
            undefined,
            repoDir,
          ),
        ),
      ),
    );

    expect(result._tag).toBe("Created");

    const log = await $`git log --oneline feature-from-explicit-cwd`
      .quiet()
      .cwd(repoDir);
    const logText = log.text();
    expect(logText).not.toContain("develop commit");
  });

  test("returns error when base branch does not exist", async () => {
    process.chdir(repoDir);
    const wtPath = join(worktreeDir, "feature-bad-base");
    await expect(
      runBunPromise(
        withWorktreeService(
          WorktreeService.use((service) =>
            service.createWorktree(
              wtPath,
              "feature-bad-base",
              false,
              "nonexistent-branch",
            ),
          ),
        ),
      ),
    ).rejects.toThrow();
  });

  test("sets the push remote for a new branch without changing its upstream", async () => {
    const branch = "feature/push-remote";
    const wtPath = join(await realpath(worktreeDir), "feature-push-remote");
    await $`git remote add origin ${repoDir}`.quiet().cwd(repoDir);
    await $`git remote add upstream ${repoDir}`.quiet().cwd(repoDir);
    await $`git update-ref refs/remotes/upstream/main develop`
      .quiet()
      .cwd(repoDir);
    await $`git config branch.autoSetupMerge true`.quiet().cwd(repoDir);
    await $`git config push.default simple`.quiet().cwd(repoDir);

    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) =>
          service.createWorktree(
            wtPath,
            branch,
            false,
            "upstream/main",
            repoDir,
            "origin",
          ),
        ),
      ),
    );
    expect(result._tag).toBe("Created");
    const head = await $`git rev-parse HEAD`.quiet().cwd(wtPath);
    const base = await $`git rev-parse upstream/main`.quiet().cwd(repoDir);
    expect(head.text()).toBe(base.text());
    const remote = await $`git config --local --get branch.${branch}.pushRemote`
      .quiet()
      .cwd(wtPath);
    expect(remote.text().trim()).toBe("origin");
    const upstream = await $`git rev-parse --abbrev-ref "@{upstream}"`
      .quiet()
      .cwd(wtPath);
    expect(upstream.text().trim()).toBe("upstream/main");
    const pushRemote =
      await $`git for-each-ref "--format=%(push:remotename)" refs/heads/${branch}`
        .quiet()
        .cwd(wtPath);
    expect(pushRemote.text().trim()).toBe("origin");

    const reopened = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) =>
          service.createWorktree(
            wtPath,
            branch,
            false,
            "upstream/main",
            repoDir,
            "missing-remote",
          ),
        ),
      ),
    );
    expect(reopened._tag).toBe("AlreadyExists");
    const unchanged =
      await $`git config --local --get branch.${branch}.pushRemote`
        .quiet()
        .cwd(wtPath);
    expect(unchanged.text().trim()).toBe("origin");
  });

  test("rejects a missing push remote before creating the branch or worktree", async () => {
    const branch = "feature-missing-remote";
    const wtPath = join(worktreeDir, branch);
    await expect(
      runBunPromise(
        withWorktreeService(
          WorktreeService.use((service) =>
            service.createWorktree(
              wtPath,
              branch,
              false,
              "main",
              repoDir,
              "missing-remote",
            ),
          ),
        ),
      ),
    ).rejects.toThrow();
    expect(await Bun.file(join(wtPath, ".git")).exists()).toBe(false);
    const ref = await $`git show-ref --verify refs/heads/${branch}`
      .quiet()
      .nothrow()
      .cwd(repoDir);
    expect(ref.exitCode).not.toBe(0);
  });

  test("preserves push configuration when checking out an existing branch", async () => {
    const branch = "existing-push-remote";
    const wtPath = join(worktreeDir, branch);
    await $`git branch ${branch} main`.quiet().cwd(repoDir);
    await $`git config branch.${branch}.pushRemote preserved`
      .quiet()
      .cwd(repoDir);
    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) =>
          service.createWorktree(
            wtPath,
            branch,
            true,
            undefined,
            repoDir,
            "missing-remote",
          ),
        ),
      ),
    );
    expect(result._tag).toBe("Created");
    const remote = await $`git config --local --get branch.${branch}.pushRemote`
      .quiet()
      .cwd(wtPath);
    expect(remote.text().trim()).toBe("preserved");
  });

  test("ignores base when using existing branch", async () => {
    process.chdir(repoDir);
    const wtPath = join(worktreeDir, "existing-branch-wt");
    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) =>
          service.createWorktree(wtPath, "develop", true, "main"),
        ),
      ),
    );

    expect(result._tag).toBe("Created");
    expect(result.path).toBe(wtPath);

    const log = await $`git log --oneline develop`.quiet().cwd(repoDir);
    expect(log.text()).toContain("develop commit");
  });

  test("treats an occupied unregistered path as a conflict", async () => {
    process.chdir(repoDir);
    const wtPath = join(worktreeDir, "occupied-path");
    await Bun.write(wtPath, "not a worktree");

    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) =>
          service.createWorktree(wtPath, "occupied-branch", false),
        ),
      ),
    );

    expect(result).toEqual({
      _tag: "PathConflict",
      path: wtPath,
    });
  });

  test("supports explicit cwd when reading current branch", async () => {
    process.chdir(originalDir);
    try {
      const result = await runBunPromise(
        withWorktreeService(
          WorktreeService.use((service) => service.getCurrentBranch(repoDir)),
        ),
      );

      expect(result).toBe("main");
    } finally {
      process.chdir(repoDir);
    }
  });

  test("supports explicit cwd when resolving the main worktree path", async () => {
    process.chdir(originalDir);
    try {
      const result = await runBunPromise(
        withWorktreeService(
          WorktreeService.use((service) =>
            service.getMainWorktreePath(repoDir),
          ),
        ),
      );

      expect(result?.replace(/^\/private/, "")).toBe(
        repoDir.replace(/^\/private/, ""),
      );
    } finally {
      process.chdir(repoDir);
    }
  });
});

describe("WorkspaceService remote fetching", () => {
  test.each(["main", "new-base"])(
    "creates from the fetched upstream/%s commit",
    async (baseBranch) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "wct-fetch-remotes-")),
      );
      const upstreamDir = join(root, "upstream");
      const originDir = join(root, "origin.git");
      const repoDir = join(root, "repo");
      try {
        await $`git init -b main --template= ${upstreamDir}`.quiet();
        await $`git config user.email test@test.com`.quiet().cwd(upstreamDir);
        await $`git config user.name Test`.quiet().cwd(upstreamDir);
        await $`git config commit.gpgSign false`.quiet().cwd(upstreamDir);
        await $`git commit --allow-empty -m initial`.quiet().cwd(upstreamDir);
        await $`git clone --bare ${upstreamDir} ${originDir}`.quiet();
        await $`git clone --origin upstream ${upstreamDir} ${repoDir}`.quiet();
        await $`git remote add origin ${originDir}`.quiet().cwd(repoDir);
        const original = await $`git rev-parse main`.quiet().cwd(repoDir);
        await $`git commit --allow-empty -m latest`.quiet().cwd(upstreamDir);
        if (baseBranch !== "main")
          await $`git branch ${baseBranch}`.quiet().cwd(upstreamDir);
        await $`git push ${originDir} HEAD:refs/heads/remote-only`
          .quiet()
          .cwd(upstreamDir);
        const latest = await $`git rev-parse HEAD`.quiet().cwd(upstreamDir);
        await Bun.write(
          join(repoDir, ".wct.yaml"),
          `project_name: demo
worktree_dir: ../worktrees
base_branch: upstream/${baseBranch}
push_remote: origin
copy: []
setup: []
tmux: { windows: [] }
profiles: {}
`,
        );
        const result = await runBunPromise(
          withTestServices(
            WorkspaceService.use((service) =>
              service.open({ branch: "fresh-feature", cwd: repoDir }),
            ),
          ),
        );
        const head = await $`git rev-parse HEAD`
          .quiet()
          .cwd(result.worktreePath);
        const originRef = await $`git rev-parse refs/remotes/origin/remote-only`
          .quiet()
          .cwd(repoDir);
        const localMain = await $`git rev-parse main`.quiet().cwd(repoDir);
        expect(result.created).toBe(true);
        expect(head.text()).toBe(latest.text());
        expect(originRef.text()).toBe(latest.text());
        expect(localMain.text()).toBe(original.text());
        expect(head.text()).not.toBe(original.text());
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("push remote setup recovery", () => {
  test.each([false, true])(
    "retries failed setup when reopening (existing: %s)",
    async (existing) => {
      const fixture = await makeIncludeRepo();
      const branch = "retry-push-remote";
      const worktreePath = join(fixture.root, "worktrees", `demo-${branch}`);
      const hookPath = join(fixture.repo, ".git/hooks/post-checkout");
      const lockPath = join(fixture.repo, ".git/config.lock");
      const remoteKey = `branch.${branch}.pushRemote`;
      const pendingKey = `branch.${branch}.wctPushRemotePending`;
      const writeConfig = (remote: string) =>
        fixture.write(
          ".wct.yaml",
          `project_name: demo
worktree_dir: ../worktrees
base_branch: main
push_remote: ${remote}
copy: []
setup: []
tmux: { windows: [] }
profiles: {}
`,
        );
      try {
        await fixture.git("remote", "add", "origin", fixture.repo);
        await writeConfig("origin");
        await fixture.write(
          ".git/hooks/post-checkout",
          `#!/bin/sh
common_dir=$(git rev-parse --git-common-dir) || exit 1
: > "$common_dir/config.lock"
`,
        );
        await chmod(hookPath, 0o755);

        await expect(
          runBunPromise(
            withTestServices(
              WorkspaceService.use((service) =>
                service.open({ branch, cwd: fixture.repo }),
              ),
            ),
          ),
        ).rejects.toMatchObject({ code: "worktree_error" });
        expect(await Bun.file(join(worktreePath, ".git")).exists()).toBe(true);
        const missingRemote = await $`git config --local --get ${remoteKey}`
          .quiet()
          .nothrow()
          .cwd(fixture.repo);
        expect(missingRemote.exitCode).toBe(1);
        const pending = await fixture.git(
          "config",
          "--local",
          "--get",
          pendingKey,
        );
        expect(pending.stdout.trim()).toBe("origin");

        await rm(lockPath);
        await rm(hookPath);
        await writeConfig("changed-default");
        const reopen = () =>
          runBunPromise(
            withTestServices(
              WorkspaceService.use((service) =>
                service.open({ branch, existing, cwd: fixture.repo }),
              ),
              {
                worktree: {
                  ...liveWorktreeService,
                  fetchRemotes: () => Effect.die("reopening must not fetch"),
                },
              },
            ),
          );
        const result = await reopen();
        expect(result.created).toBe(false);
        const remote = await fixture.git(
          "config",
          "--local",
          "--get",
          remoteKey,
        );
        expect(remote.stdout.trim()).toBe("origin");
        const cleared = await $`git config --local --get ${pendingKey}`
          .quiet()
          .nothrow()
          .cwd(fixture.repo);
        expect(cleared.exitCode).toBe(1);

        await fixture.git("config", "--local", remoteKey, "preserved");
        await reopen();
        const preserved = await fixture.git(
          "config",
          "--local",
          "--get",
          remoteKey,
        );
        expect(preserved.stdout.trim()).toBe("preserved");
      } finally {
        await fixture.cleanup();
      }
    },
  );

  test("does not leave pending setup for an already-existing branch", async () => {
    const fixture = await makeIncludeRepo();
    try {
      await fixture.git("remote", "add", "origin", fixture.repo);
      await fixture.git("branch", "existing-feature");
      await expect(
        runBunPromise(
          withTestServices(
            WorktreeService.use((service) =>
              service.createWorktree(
                join(fixture.root, "existing-feature"),
                "existing-feature",
                false,
                "main",
                fixture.repo,
                "origin",
              ),
            ),
          ),
        ),
      ).rejects.toThrow();
      const pending =
        await $`git config --local --get branch.existing-feature.wctPushRemotePending`
          .quiet()
          .nothrow()
          .cwd(fixture.repo);
      expect(pending.exitCode).toBe(1);
      const remote =
        await $`git config --local --get branch.existing-feature.pushRemote`
          .quiet()
          .nothrow()
          .cwd(fixture.repo);
      expect(remote.exitCode).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test("clears pending intent when creation fails before the branch exists", async () => {
    const fixture = await makeIncludeRepo();
    const branch = "abandoned-creation";
    const path = join(fixture.root, branch);
    try {
      await fixture.git("remote", "add", "origin", fixture.repo);
      await expect(
        runBunPromise(
          withTestServices(
            WorktreeService.use((service) =>
              service.createWorktree(
                path,
                branch,
                false,
                "missing-base",
                fixture.repo,
                "origin",
              ),
            ),
          ),
        ),
      ).rejects.toThrow();
      const pending =
        await $`git config --local --get branch.${branch}.wctPushRemotePending`
          .quiet()
          .nothrow()
          .cwd(fixture.repo);
      expect(pending.exitCode).toBe(1);

      await fixture.git("branch", branch);
      await fixture.git("config", `branch.${branch}.pushRemote`, "preserved");
      const result = await runBunPromise(
        withTestServices(
          WorktreeService.use((service) =>
            service.createWorktree(path, branch, true, undefined, fixture.repo),
          ),
        ),
      );
      expect(result._tag).toBe("Created");
      const remote = await fixture.git(
        "config",
        "--get",
        `branch.${branch}.pushRemote`,
      );
      expect(remote.stdout.trim()).toBe("preserved");
    } finally {
      await fixture.cleanup();
    }
  });
});

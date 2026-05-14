import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  startWorktreeSession,
  stopWorktreeSession,
} from "../src/commands/worktree-session";
import { DEFAULT_IDE_CONFIG } from "../src/config/loader";
import { runBunPromise } from "../src/effect/runtime";
import { commandError } from "../src/errors";
import { liveTmuxService } from "../src/services/tmux";
import { liveWorktreeService } from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

interface LinkedWorktreeFixture {
  repoDir: string;
  worktreeDir: string;
}

async function createLinkedWorktreeFixture(
  repoPrefix: string,
  worktreePrefix: string,
): Promise<LinkedWorktreeFixture> {
  const repoDir = await realpath(await mkdtemp(join(tmpdir(), repoPrefix)));
  const worktreeDir = await realpath(
    await mkdtemp(join(tmpdir(), worktreePrefix)),
  );

  await $`git init -b main`.quiet().cwd(repoDir);
  await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
  await $`git config user.name "Test"`.quiet().cwd(repoDir);
  await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
  await $`git commit --allow-empty -m "initial"`.quiet().cwd(repoDir);

  const wtPath = join(worktreeDir, "feature-branch");
  await $`git worktree add -b feature-branch ${wtPath}`.quiet().cwd(repoDir);

  return { repoDir, worktreeDir };
}

async function cleanupLinkedWorktreeFixture(
  fixture: LinkedWorktreeFixture,
  originalDir: string,
): Promise<void> {
  process.chdir(originalDir);
  await $`git worktree remove ${join(fixture.worktreeDir, "feature-branch")}`
    .quiet()
    .cwd(fixture.repoDir)
    .nothrow();
  await rm(fixture.repoDir, { recursive: true, force: true });
  await rm(fixture.worktreeDir, { recursive: true, force: true });
}

describe("startWorktreeSession", () => {
  let fixture: LinkedWorktreeFixture;
  let wtPath: string;
  const originalDir = process.cwd();

  beforeAll(async () => {
    fixture = await createLinkedWorktreeFixture(
      "wct-shared-up-",
      "wct-shared-up-wt-",
    );
    wtPath = join(fixture.worktreeDir, "feature-branch");

    await Bun.write(
      join(fixture.repoDir, ".wct.yaml"),
      `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
ide:
  command: "echo ide"
`,
    );
  });

  afterAll(async () => {
    await cleanupLinkedWorktreeFixture(fixture, originalDir);
  });

  test("rejects ide and noIde together", async () => {
    await expect(
      runBunPromise(
        withTestServices(
          startWorktreeSession({
            path: wtPath,
            ide: true,
            noIde: true,
          }),
        ),
      ),
    ).rejects.toThrow("Options --ide and --no-ide cannot be used together");
  });

  test("returns structured session start data for a worktree path", async () => {
    const createCalls: Array<{ name: string; workingDir: string }> = [];
    const ideCalls: string[] = [];

    process.chdir(fixture.repoDir);

    const result = await runBunPromise(
      withTestServices(startWorktreeSession({ path: wtPath }), {
        worktree: {
          ...liveWorktreeService,
          isGitRepo: (cwd?: string) => Effect.succeed(cwd === wtPath),
          getMainRepoPath: (cwd?: string) =>
            Effect.succeed(cwd === wtPath ? fixture.repoDir : null),
          getCurrentBranch: (cwd?: string) =>
            Effect.succeed(cwd === wtPath ? "feature-branch" : null),
        },
        tmux: {
          ...liveTmuxService,
          createSession: (name, workingDir) =>
            Effect.sync(() => {
              createCalls.push({ name, workingDir });
              return {
                _tag: "Created" as const,
                sessionName: name,
              };
            }),
        },
        ide: {
          openIDE: (_command, env) =>
            Effect.sync(() => {
              ideCalls.push(env.WCT_BRANCH);
            }),
        },
      }),
    );

    expect(result.worktreePath).toBe(wtPath);
    expect(result.mainRepoPath).toBe(fixture.repoDir);
    expect(result.branch).toBe("feature-branch");
    expect(result.sessionName).toBe("feature-branch");
    expect(result.projectName).toBe("myapp");
    expect(result.tmux).toEqual({
      attempted: true,
      ok: true,
      value: {
        _tag: "Created",
        sessionName: "feature-branch",
      },
    });
    expect(result.ide).toEqual({
      attempted: true,
      ok: true,
      value: undefined,
    });
    expect(createCalls).toEqual([
      {
        name: "feature-branch",
        workingDir: wtPath,
      },
    ]);
    expect(ideCalls).toEqual(["feature-branch"]);
  });

  test("captures tmux creation failures without rejecting", async () => {
    process.chdir(fixture.repoDir);

    const result = await runBunPromise(
      withTestServices(
        startWorktreeSession({
          path: wtPath,
          noIde: true,
        }),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: (cwd?: string) => Effect.succeed(cwd === wtPath),
            getMainRepoPath: (cwd?: string) =>
              Effect.succeed(cwd === wtPath ? fixture.repoDir : null),
            getCurrentBranch: (cwd?: string) =>
              Effect.succeed(cwd === wtPath ? "feature-branch" : null),
          },
          tmux: {
            ...liveTmuxService,
            createSession: () =>
              Effect.fail(commandError("tmux_error", "tmux boom")),
          },
        },
      ),
    );

    expect(result.tmux).toMatchObject({
      attempted: true,
      ok: false,
      error: {
        code: "tmux_error",
        message: "tmux boom",
      },
    });
    expect(result.ide).toEqual({ attempted: false });
  });

  test("skips IDE by default when config omits ide", async () => {
    const wctYamlPath = join(fixture.repoDir, ".wct.yaml");
    const originalYaml = await Bun.file(wctYamlPath).text();
    const originalHome = process.env.HOME;
    const homeDir = await mkdtemp(join(tmpdir(), "wct-session-home-"));

    try {
      process.env.HOME = homeDir;
      await Bun.write(
        wctYamlPath,
        `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
`,
      );

      process.chdir(fixture.repoDir);

      const ideCalls: string[] = [];
      const result = await runBunPromise(
        withTestServices(startWorktreeSession({ path: wtPath }), {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: (cwd?: string) => Effect.succeed(cwd === wtPath),
            getMainRepoPath: (cwd?: string) =>
              Effect.succeed(cwd === wtPath ? fixture.repoDir : null),
            getCurrentBranch: (cwd?: string) =>
              Effect.succeed(cwd === wtPath ? "feature-branch" : null),
          },
          tmux: {
            ...liveTmuxService,
            createSession: (name) =>
              Effect.succeed({
                _tag: "Created" as const,
                sessionName: name,
              }),
          },
          ide: {
            openIDE: (command) =>
              Effect.sync(() => {
                ideCalls.push(command);
              }),
          },
        }),
      );

      expect(result.ide).toEqual({ attempted: false });
      expect(ideCalls).toEqual([]);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      process.chdir(originalDir);
      await Bun.write(wctYamlPath, originalYaml);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("opens fallback IDE when ide flag is passed and config omits ide", async () => {
    const wctYamlPath = join(fixture.repoDir, ".wct.yaml");
    const originalYaml = await Bun.file(wctYamlPath).text();
    const originalHome = process.env.HOME;
    const homeDir = await mkdtemp(join(tmpdir(), "wct-session-home-"));

    try {
      process.env.HOME = homeDir;
      await Bun.write(
        wctYamlPath,
        `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
`,
      );

      process.chdir(fixture.repoDir);

      const ideCalls: string[] = [];
      const result = await runBunPromise(
        withTestServices(startWorktreeSession({ path: wtPath, ide: true }), {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: (cwd?: string) => Effect.succeed(cwd === wtPath),
            getMainRepoPath: (cwd?: string) =>
              Effect.succeed(cwd === wtPath ? fixture.repoDir : null),
            getCurrentBranch: (cwd?: string) =>
              Effect.succeed(cwd === wtPath ? "feature-branch" : null),
          },
          tmux: {
            ...liveTmuxService,
            createSession: (name) =>
              Effect.succeed({
                _tag: "Created" as const,
                sessionName: name,
              }),
          },
          ide: {
            openIDE: (command) =>
              Effect.sync(() => {
                ideCalls.push(command);
              }),
          },
        }),
      );

      expect(result.ide).toMatchObject({
        attempted: true,
        ok: true,
      });
      expect(ideCalls).toEqual([DEFAULT_IDE_CONFIG.command]);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      process.chdir(originalDir);
      await Bun.write(wctYamlPath, originalYaml);
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe("stopWorktreeSession", () => {
  test("returns existed false when the session does not exist", async () => {
    const killCalls: string[] = [];

    const result = await runBunPromise(
      withTestServices(stopWorktreeSession({ path: "/tmp/myapp-feature-x" }), {
        worktree: {
          ...liveWorktreeService,
          isGitRepo: (cwd?: string) =>
            Effect.succeed(cwd === "/tmp/myapp-feature-x"),
        },
        tmux: {
          ...liveTmuxService,
          sessionExists: () => Effect.succeed(false),
          killSession: (name: string) =>
            Effect.sync(() => {
              killCalls.push(name);
            }),
        },
      }),
    );

    expect(result).toEqual({
      worktreePath: "/tmp/myapp-feature-x",
      sessionName: "myapp-feature-x",
      existed: false,
    });
    expect(killCalls).toEqual([]);
  });
});

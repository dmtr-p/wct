import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { commandDef, upCommand } from "../src/commands/up";
import { DEFAULT_IDE_CONFIG } from "../src/config/loader";
import { runBunPromise } from "../src/effect/runtime";
import { provideWctServices } from "../src/effect/services";
import { commandError } from "../src/errors";
import { liveTmuxService } from "../src/services/tmux";
import {
  liveWorktreeService,
  WorktreeService,
} from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

function withWorktreeService<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return provideWctServices(
    Effect.provideService(effect, WorktreeService, liveWorktreeService),
  );
}

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

describe("getCurrentBranch", () => {
  test("returns current branch name in a git repo", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "wct-test-branch-"));
    const originalDir = process.cwd();

    try {
      await $`git init -b test-branch`.quiet().cwd(tempDir);
      await $`git config user.email "test@test.com"`.quiet().cwd(tempDir);
      await $`git config user.name "Test"`.quiet().cwd(tempDir);
      await $`git config commit.gpgSign false`.quiet().cwd(tempDir);
      await $`git commit --allow-empty -m "initial"`.quiet().cwd(tempDir);

      process.chdir(tempDir);
      const branch = await runBunPromise(
        withWorktreeService(
          WorktreeService.use((service) => service.getCurrentBranch()),
        ),
      );
      expect(branch).toBe("test-branch");
    } finally {
      process.chdir(originalDir);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns null on detached HEAD", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "wct-test-detached-"));
    const originalDir = process.cwd();

    try {
      await $`git init -b main`.quiet().cwd(tempDir);
      await $`git config user.email "test@test.com"`.quiet().cwd(tempDir);
      await $`git config user.name "Test"`.quiet().cwd(tempDir);
      await $`git config commit.gpgSign false`.quiet().cwd(tempDir);
      await $`git commit --allow-empty -m "initial"`.quiet().cwd(tempDir);
      const sha = await $`git rev-parse HEAD`.quiet().cwd(tempDir).text();
      await $`git checkout ${sha.trim()}`.quiet().cwd(tempDir);

      process.chdir(tempDir);
      const branch = await runBunPromise(
        withWorktreeService(
          WorktreeService.use((service) => service.getCurrentBranch()),
        ),
      );
      expect(branch).toBeNull();
    } finally {
      process.chdir(originalDir);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("getMainWorktreePath", () => {
  let repoDir: string;
  let worktreeDir: string;
  const originalDir = process.cwd();

  beforeAll(async () => {
    const fixture = await createLinkedWorktreeFixture(
      "wct-test-main-wt-",
      "wct-test-wt-",
    );
    repoDir = fixture.repoDir;
    worktreeDir = fixture.worktreeDir;
  });

  afterAll(async () => {
    await cleanupLinkedWorktreeFixture({ repoDir, worktreeDir }, originalDir);
  });

  test("returns main repo path when run from main repo", async () => {
    process.chdir(repoDir);
    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) => service.getMainWorktreePath()),
      ),
    );
    expect(result).toBe(repoDir);
  });

  test("returns main repo path when run from a worktree", async () => {
    const wtPath = join(worktreeDir, "feature-branch");
    process.chdir(wtPath);
    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) => service.getMainWorktreePath()),
      ),
    );
    expect(result).toBe(repoDir);
  });
});

describe("getMainRepoPath", () => {
  let repoDir: string;
  let worktreeDir: string;
  const originalDir = process.cwd();
  const originalPath = process.env.PATH;

  beforeAll(async () => {
    const fixture = await createLinkedWorktreeFixture(
      "wct-test-main-repo-",
      "wct-test-main-repo-wt-",
    );
    repoDir = fixture.repoDir;
    worktreeDir = fixture.worktreeDir;
  });

  afterAll(async () => {
    await cleanupLinkedWorktreeFixture({ repoDir, worktreeDir }, originalDir);
  });

  test("returns main repo path when run from main repo", async () => {
    process.chdir(repoDir);
    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) => service.getMainRepoPath()),
      ),
    );
    expect(result).toBe(repoDir);
  });

  test("returns main repo path when run from a worktree", async () => {
    const wtPath = join(worktreeDir, "feature-branch");
    process.chdir(wtPath);
    const result = await runBunPromise(
      withWorktreeService(
        WorktreeService.use((service) => service.getMainRepoPath()),
      ),
    );
    expect(result).toBe(repoDir);
  });

  async function withFailingWorktreeList(cwd: string, fn: () => Promise<void>) {
    const fakeBinDir = await mkdtemp(join(tmpdir(), "wct-test-fake-git-"));
    const realGit = (await $`which git`.quiet().text()).trim();
    const fakeGitPath = join(fakeBinDir, "git");
    try {
      await Bun.write(
        fakeGitPath,
        `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ "$3" = "--porcelain" ]; then
  echo "simulated git worktree failure" >&2
  exit 1
fi
exec "${realGit}" "$@"
`,
      );
      await chmod(fakeGitPath, 0o755);

      process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
      process.chdir(cwd);
      await fn();
    } finally {
      process.env.PATH = originalPath;
      process.chdir(originalDir);
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  }

  test("falls back to rev-parse when git worktree list fails", async () => {
    await withFailingWorktreeList(repoDir, async () => {
      const result = await runBunPromise(
        withWorktreeService(
          WorktreeService.use((service) => service.getMainRepoPath()),
        ),
      );
      expect(result).toBe(repoDir);
    });
  });

  test("falls back to the main repo path when git worktree list fails in a linked worktree", async () => {
    const wtPath = join(worktreeDir, "feature-branch");
    await withFailingWorktreeList(wtPath, async () => {
      const result = await runBunPromise(
        withWorktreeService(
          WorktreeService.use((service) => service.getMainRepoPath()),
        ),
      );
      expect(result).toBe(repoDir);
    });
  });
});

describe("upCommand", () => {
  test("is exported as a function", () => {
    expect(typeof upCommand).toBe("function");
  });

  test("completes --branch from worktree branches only", () => {
    const branchOption = commandDef.options?.find(
      (option) => option.name === "branch",
    );

    expect(branchOption?.completionValues).toBe("__wct_worktree_branches");
  });

  test("includes ide command metadata option", () => {
    const ideOption = commandDef.options?.find(
      (option) => option.name === "ide",
    );

    expect(ideOption).toMatchObject({
      name: "ide",
      type: "boolean",
      description: "Force opening IDE",
    });
  });

  test("resolves worktree path via --path flag outside a git repo", async () => {
    const fixture = await createLinkedWorktreeFixture(
      "wct-up-path-flag-",
      "wct-up-path-flag-wt-",
    );
    const outsideDir = await mkdtemp(join(tmpdir(), "wct-up-outside-"));
    const originalDir = process.cwd();
    const wtPath = join(fixture.worktreeDir, "feature-branch");

    try {
      await Bun.write(
        join(fixture.repoDir, ".wct.yaml"),
        `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
`,
      );

      process.chdir(outsideDir);

      const createCalls: string[] = [];
      await runBunPromise(
        withTestServices(upCommand({ path: wtPath }), {
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
            createSession: (_name, workingDir) =>
              Effect.sync(() => {
                createCalls.push(workingDir);
                return {
                  _tag: "Created" as const,
                  sessionName: "test",
                };
              }),
          },
        }),
      );

      expect(createCalls[0]).toBe(wtPath);
    } finally {
      process.chdir(originalDir);
      await cleanupLinkedWorktreeFixture(fixture, originalDir);
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("resolves worktree path via --branch flag", async () => {
    const fixture = await createLinkedWorktreeFixture(
      "wct-up-branch-flag-",
      "wct-up-branch-flag-wt-",
    );
    const originalDir = process.cwd();
    const wtPath = join(fixture.worktreeDir, "feature-branch");

    try {
      await Bun.write(
        join(fixture.repoDir, ".wct.yaml"),
        `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
`,
      );

      process.chdir(fixture.repoDir);

      const createCalls: string[] = [];
      await runBunPromise(
        withTestServices(upCommand({ branch: "feature-branch" }), {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(fixture.repoDir),
            getCurrentBranch: (cwd?: string) =>
              Effect.succeed(cwd === wtPath ? "feature-branch" : "main"),
          },
          tmux: {
            ...liveTmuxService,
            createSession: (_name, workingDir) =>
              Effect.sync(() => {
                createCalls.push(workingDir);
                return {
                  _tag: "Created" as const,
                  sessionName: "test",
                };
              }),
          },
        }),
      );

      expect(createCalls[0]).toBe(wtPath);
    } finally {
      process.chdir(originalDir);
      await cleanupLinkedWorktreeFixture(fixture, originalDir);
    }
  });

  test("passes ide flag through to session startup", async () => {
    const fixture = await createLinkedWorktreeFixture(
      "wct-up-ide-flag-",
      "wct-up-ide-flag-wt-",
    );
    const originalDir = process.cwd();
    const originalHome = process.env.HOME;
    const homeDir = await mkdtemp(join(tmpdir(), "wct-up-home-"));
    const wtPath = join(fixture.worktreeDir, "feature-branch");

    try {
      process.env.HOME = homeDir;
      await Bun.write(
        join(fixture.repoDir, ".wct.yaml"),
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
      await runBunPromise(
        withTestServices(
          upCommand({ path: wtPath, ide: true, noAttach: true }),
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
              createSession: (_name, _workingDir) =>
                Effect.succeed({
                  _tag: "Created" as const,
                  sessionName: "test",
                }),
            },
            ide: {
              openIDE: (command) =>
                Effect.sync(() => {
                  ideCalls.push(command);
                }),
            },
          },
        ),
      );

      expect(ideCalls).toEqual([DEFAULT_IDE_CONFIG.command]);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      process.chdir(originalDir);
      await cleanupLinkedWorktreeFixture(fixture, originalDir);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("does not print attach guidance when tmux session creation fails", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "wct-up-tmux-fail-"));
    const originalDir = process.cwd();
    const originalTmux = process.env.TMUX;
    delete process.env.TMUX;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await $`git init -b main`.quiet().cwd(repoDir);
      await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
      await $`git config user.name "Test"`.quiet().cwd(repoDir);
      await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
      await $`git commit --allow-empty -m "initial"`.quiet().cwd(repoDir);
      await Bun.write(
        join(repoDir, ".wct.yaml"),
        `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
`,
      );

      process.chdir(repoDir);

      await expect(
        runBunPromise(
          withTestServices(upCommand(), {
            worktree: {
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
              getMainRepoPath: () => Effect.succeed(repoDir),
              getCurrentBranch: () => Effect.succeed("main"),
            },
            tmux: {
              ...liveTmuxService,
              createSession: () =>
                Effect.fail(commandError("tmux_error", "tmux boom")),
            },
          }),
        ),
      ).resolves.toBeUndefined();

      const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(
        loggedLines.some((line) => line.includes("Attach to tmux session")),
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      process.chdir(originalDir);
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("prints attach guidance and does not attach when --no-attach is set", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "wct-up-no-attach-"));
    const originalDir = process.cwd();
    const originalTmux = process.env.TMUX;
    delete process.env.TMUX;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const attachCalls: string[] = [];

    try {
      await $`git init -b main`.quiet().cwd(repoDir);
      await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
      await $`git config user.name "Test"`.quiet().cwd(repoDir);
      await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
      await $`git commit --allow-empty -m "initial"`.quiet().cwd(repoDir);
      await Bun.write(
        join(repoDir, ".wct.yaml"),
        `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
`,
      );

      process.chdir(repoDir);

      await expect(
        runBunPromise(
          withTestServices(upCommand({ noAttach: true }), {
            worktree: {
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
              getMainRepoPath: () => Effect.succeed(repoDir),
              getCurrentBranch: () => Effect.succeed("main"),
            },
            tmux: {
              ...liveTmuxService,
              createSession: () =>
                Effect.succeed({
                  _tag: "Created" as const,
                  sessionName: "myapp-main",
                }),
              attachSession: (name) =>
                Effect.sync(() => {
                  attachCalls.push(name);
                }),
            },
          }),
        ),
      ).resolves.toBeUndefined();

      expect(attachCalls).toEqual([]);
      const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(
        loggedLines.some((line) => line.includes("Attach to tmux session")),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      process.chdir(originalDir);
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("prints attach guidance and does not attach without a TTY", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "wct-up-no-tty-"));
    const originalDir = process.cwd();
    const originalTmux = process.env.TMUX;
    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    delete process.env.TMUX;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const attachCalls: string[] = [];

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });

    try {
      await $`git init -b main`.quiet().cwd(repoDir);
      await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
      await $`git config user.name "Test"`.quiet().cwd(repoDir);
      await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
      await $`git commit --allow-empty -m "initial"`.quiet().cwd(repoDir);
      await Bun.write(
        join(repoDir, ".wct.yaml"),
        `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
`,
      );

      process.chdir(repoDir);

      await expect(
        runBunPromise(
          withTestServices(upCommand(), {
            worktree: {
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
              getMainRepoPath: () => Effect.succeed(repoDir),
              getCurrentBranch: () => Effect.succeed("main"),
            },
            tmux: {
              ...liveTmuxService,
              createSession: () =>
                Effect.succeed({
                  _tag: "Created" as const,
                  sessionName: "myapp-main",
                }),
              attachSession: (name) =>
                Effect.sync(() => {
                  attachCalls.push(name);
                }),
            },
          }),
        ),
      ).resolves.toBeUndefined();

      expect(attachCalls).toEqual([]);
      const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(
        loggedLines.some((line) => line.includes("Attach to tmux session")),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      process.chdir(originalDir);
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runBunPromise } from "../src/effect/runtime";
import { commandError } from "../src/errors";
import { liveTmuxService, type TmuxService } from "../src/services/tmux";
import {
  liveWorkspaceService,
  type WorkspaceReporterEvent,
  WorkspaceService,
} from "../src/services/workspace-service";
import {
  liveWorktreeService,
  type WorktreeService,
} from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

async function writeConfig(repoDir: string, body = "") {
  await Bun.write(
    join(repoDir, ".wct.yaml"),
    `version: 1
worktree_dir: "../worktrees"
project_name: "myapp"
tmux:
  windows:
    - name: "main"
ide:
  command: "echo ide"
${body}`,
  );
}

describe("WorkspaceService target resolution", () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/current-worktree");
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  test("resolves current directory, explicit path, and branch targets", async () => {
    const seenPaths: string[] = [];
    const worktree: WorktreeService = {
      ...liveWorktreeService,
      isGitRepo: (cwd) =>
        Effect.sync(() => {
          if (cwd) seenPaths.push(cwd);
          return true;
        }),
      findWorktreeByBranch: (branch) =>
        Effect.succeed(
          branch === "feature"
            ? {
                path: "/tmp/feature-worktree",
                branch,
                commit: "abc123",
                isBare: false,
              }
            : null,
        ),
    };

    const tmux: TmuxService = {
      ...liveTmuxService,
      sessionExists: () => Effect.succeed(false),
    };

    const current = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.down()),
        { tmux, worktree },
      ),
    );
    const explicit = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.down({ path: "/tmp/explicit-worktree" }),
        ),
        { tmux, worktree },
      ),
    );
    const branch = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.down({ branch: "feature" })),
        { tmux, worktree },
      ),
    );

    expect(current.worktreePath).toBe("/tmp/current-worktree");
    expect(explicit.worktreePath).toBe("/tmp/explicit-worktree");
    expect(branch.worktreePath).toBe("/tmp/feature-worktree");
    expect(seenPaths).toEqual([
      "/tmp/current-worktree",
      "/tmp/explicit-worktree",
      "/tmp/feature-worktree",
    ]);
  });

  test("rejects mutually exclusive path and branch targets", async () => {
    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.down({ path: "/tmp/a", branch: "feature" }),
          ),
        ),
      ),
    ).rejects.toThrow("--path and --branch are mutually exclusive");
  });

  test("up resolves branch targets through WorkspaceService", async () => {
    const mainRepoPath = await mkdtemp(join(tmpdir(), "wct-workspace-main-"));
    const worktree: WorktreeService = {
      ...liveWorktreeService,
      findWorktreeByBranch: (branch) =>
        Effect.succeed(
          branch === "feature"
            ? {
                path: "/tmp/feature-worktree",
                branch,
                commit: "abc123",
                isBare: false,
              }
            : null,
        ),
      isGitRepo: (cwd) => Effect.succeed(cwd === "/tmp/feature-worktree"),
      getMainRepoPath: () => Effect.succeed(mainRepoPath),
      getCurrentBranch: () => Effect.succeed("feature"),
    };

    try {
      await writeConfig(mainRepoPath);

      const result = await runBunPromise(
        withTestServices(
          WorkspaceService.use((service) => service.up({ branch: "feature" })),
          {
            worktree,
            tmux: {
              ...liveTmuxService,
              createSession: (name) =>
                Effect.succeed({
                  _tag: "Created" as const,
                  sessionName: name,
                }),
            },
            ide: {
              openIDE: () => Effect.succeed(undefined),
            },
          },
        ),
      );

      expect(result.worktreePath).toBe("/tmp/feature-worktree");
      expect(result.branch).toBe("feature");
    } finally {
      await rm(mainRepoPath, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceService up", () => {
  let repoDir: string;
  let worktreeRoot: string;
  let worktreePath: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "wct-workspace-repo-"));
    worktreeRoot = await mkdtemp(join(tmpdir(), "wct-workspace-wt-"));
    worktreePath = join(worktreeRoot, "myapp-feature");
    await writeConfig(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  test("starts tmux and IDE without running copy or setup", async () => {
    const calls: string[] = [];
    const sourceFile = join(repoDir, ".env.local");
    const copiedFile = join(worktreePath, ".env.local");
    await mkdir(worktreePath, { recursive: true });
    await Bun.write(sourceFile, "SECRET=1\n");
    await writeConfig(
      repoDir,
      `copy:
  - ".env.local"
`,
    );

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.up({ path: worktreePath })),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: (cwd) => Effect.succeed(cwd === worktreePath),
            getMainRepoPath: () => Effect.succeed(repoDir),
            getCurrentBranch: () => Effect.succeed("feature"),
          },
          tmux: {
            ...liveTmuxService,
            createSession: (name, workingDir) =>
              Effect.sync(() => {
                calls.push(`tmux:${name}:${workingDir}`);
                return { _tag: "AlreadyExists" as const, sessionName: name };
              }),
          },
          ide: {
            openIDE: (_command, env) =>
              Effect.sync(() => {
                calls.push(`ide:${env.WCT_BRANCH}`);
              }),
          },
          setup: {
            runSetupCommands: () =>
              Effect.sync(() => {
                calls.push("setup");
                return [];
              }),
          },
        },
      ),
    );

    expect(result.attempts.tmux).toEqual({
      attempted: true,
      ok: true,
      value: { _tag: "AlreadyExists", sessionName: "myapp-feature" },
    });
    expect(result.attempts.ide).toEqual({
      attempted: true,
      ok: true,
      value: null,
    });
    expect(result.warnings).toEqual([]);
    expect(calls).toContain(`tmux:myapp-feature:${worktreePath}`);
    expect(calls).toContain("ide:feature");
    expect(calls).not.toContain("setup");
    expect(await Bun.file(copiedFile).exists()).toBe(false);
  });

  test("uses explicit profile config for tmux and IDE behavior", async () => {
    await writeConfig(
      repoDir,
      `profiles:
  focused:
    tmux:
      windows:
        - name: "profile-window"
    ide:
      command: "echo profile-ide"
`,
    );
    const tmuxWindowNames: Array<string | undefined> = [];
    const ideCommands: string[] = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.up({ path: worktreePath, profile: "focused" }),
        ),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(repoDir),
            getCurrentBranch: () => Effect.succeed("feature"),
          },
          tmux: {
            ...liveTmuxService,
            createSession: (name, _workingDir, config) =>
              Effect.sync(() => {
                tmuxWindowNames.push(config?.windows?.[0]?.name);
                return { _tag: "Created" as const, sessionName: name };
              }),
          },
          ide: {
            openIDE: (command) =>
              Effect.sync(() => {
                ideCommands.push(command);
              }),
          },
        },
      ),
    );

    expect(result.profileName).toBe("focused");
    expect(tmuxWindowNames).toEqual(["profile-window"]);
    expect(ideCommands).toEqual(["echo profile-ide"]);
  });

  test("captures tmux and IDE failures as JSON-safe warnings and attempts", async () => {
    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.up({ path: worktreePath })),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getMainRepoPath: () => Effect.succeed(repoDir),
            getCurrentBranch: () => Effect.succeed("feature"),
          },
          tmux: {
            ...liveTmuxService,
            createSession: () =>
              Effect.fail(commandError("tmux_error", "tmux boom")),
          },
          ide: {
            openIDE: () =>
              Effect.fail(commandError("unexpected_error", "ide boom")),
          },
        },
      ),
    );

    expect(result.attempts.tmux).toMatchObject({
      attempted: true,
      ok: false,
      error: { code: "tmux_error", message: "tmux boom" },
    });
    expect(result.attempts.ide).toMatchObject({
      attempted: true,
      ok: false,
      error: { code: "unexpected_error", message: "ide boom" },
    });
    expect(result.warnings).toEqual([
      {
        _tag: "TmuxStartFailed",
        operation: "up",
        error: { code: "tmux_error", message: "tmux boom" },
      },
      {
        _tag: "IdeOpenFailed",
        operation: "up",
        error: { code: "unexpected_error", message: "ide boom" },
      },
    ]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("WorkspaceService down", () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/myapp-feature");
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  test("kills an existing tmux session", async () => {
    const killCalls: string[] = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.down()),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
          },
          tmux: {
            ...liveTmuxService,
            sessionExists: () => Effect.succeed(true),
            killSession: (name) =>
              Effect.sync(() => {
                killCalls.push(name);
              }),
          },
        },
      ),
    );

    expect(result).toEqual({
      operation: "down",
      worktreePath: "/tmp/myapp-feature",
      sessionName: "myapp-feature",
      existed: true,
      status: "killed",
      attempts: {
        kill: {
          attempted: true,
          ok: true,
          value: null,
        },
      },
      warnings: [],
    });
    expect(killCalls).toEqual(["myapp-feature"]);
  });

  test("treats an absent session as informational success", async () => {
    const killCalls: string[] = [];

    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.down()),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
          },
          tmux: {
            ...liveTmuxService,
            sessionExists: () => Effect.succeed(false),
            killSession: (name) =>
              Effect.sync(() => {
                killCalls.push(name);
              }),
          },
        },
      ),
    );

    expect(result.status).toBe("absent");
    expect(result.attempts.kill).toEqual({
      attempted: false,
      reason: "session_absent",
    });
    expect(result.warnings).toEqual([]);
    expect(killCalls).toEqual([]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("fails when branch target cannot be resolved", async () => {
    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.down({ branch: "missing-branch" }),
          ),
          {
            worktree: {
              ...liveWorktreeService,
              findWorktreeByBranch: () => Effect.succeed(null),
            },
          },
        ),
      ),
    ).rejects.toThrow("No worktree found for branch 'missing-branch'");
  });

  test("treats tmux kill failure as fatal", async () => {
    const tmux: TmuxService = {
      ...liveTmuxService,
      sessionExists: () => Effect.succeed(true),
      killSession: () => Effect.fail(commandError("tmux_error", "kill boom")),
    };

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) => service.down()),
          {
            worktree: {
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
            },
            tmux,
          },
        ),
      ),
    ).rejects.toThrow("kill boom");
  });
});

describe("WorkspaceService reporter", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "wct-workspace-reporter-repo-"));
    await writeConfig(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  test("emits up events in deterministic operation order while starting tmux and IDE in parallel", async () => {
    const events: WorkspaceReporterEvent[] = [];
    const calls: string[] = [];
    let ideStarted = false;

    const reporter = {
      event: (event: WorkspaceReporterEvent) =>
        Effect.sync(() => {
          events.push(event);
        }),
    };

    const result = await Promise.race([
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.up({ path: "/tmp/myapp-feature", reporter }),
          ),
          {
            worktree: {
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
              getMainRepoPath: () => Effect.succeed(repoDir),
              getCurrentBranch: () => Effect.succeed("feature"),
            },
            tmux: {
              ...liveTmuxService,
              createSession: (name) =>
                Effect.promise(async () => {
                  calls.push("tmux-started");
                  while (!ideStarted) {
                    await Bun.sleep(1);
                  }
                  calls.push("tmux-completed");
                  return { _tag: "Created" as const, sessionName: name };
                }),
            },
            ide: {
              openIDE: () =>
                Effect.promise(async () => {
                  calls.push("ide-started");
                  ideStarted = true;
                  await Bun.sleep(1);
                  calls.push("ide-completed");
                }),
            },
          },
        ),
      ),
      Bun.sleep(100).then(() => {
        throw new Error("workspace up did not start tmux and IDE in parallel");
      }),
    ]);

    expect(result.attempts.tmux).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result.attempts.ide).toMatchObject({
      attempted: true,
      ok: true,
    });
    expect(result).not.toHaveProperty("events");
    expect(calls).toEqual([
      "tmux-started",
      "ide-started",
      "tmux-completed",
      "ide-completed",
    ]);
    expect(events).toEqual([
      {
        operation: "up",
        _tag: "TargetResolved",
        worktreePath: "/tmp/myapp-feature",
      },
      {
        operation: "up",
        _tag: "ProfileResolved",
      },
      {
        operation: "up",
        _tag: "AttemptStarted",
        attempt: "tmux",
      },
      {
        operation: "up",
        _tag: "AttemptStarted",
        attempt: "ide",
      },
      {
        operation: "up",
        _tag: "AttemptCompleted",
        attempt: "tmux",
        ok: true,
      },
      {
        operation: "up",
        _tag: "AttemptCompleted",
        attempt: "ide",
        ok: true,
      },
    ]);
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  });

  test("emits typed events in order and swallows reporter failures", async () => {
    const events: WorkspaceReporterEvent[] = [];
    const reporter = {
      event: (event: WorkspaceReporterEvent) =>
        Effect.sync(() => {
          events.push(event);
          if (event._tag === "TargetResolved") {
            throw new Error("reporter failed");
          }
        }),
    };

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.down({ path: "/tmp/myapp-feature", reporter }),
          ),
          {
            worktree: {
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
            },
            tmux: {
              ...liveTmuxService,
              sessionExists: () => Effect.succeed(false),
            },
          },
        ),
      ),
    ).resolves.toMatchObject({ status: "absent" });

    expect(events).toEqual([
      {
        operation: "down",
        _tag: "TargetResolved",
        worktreePath: "/tmp/myapp-feature",
      },
      {
        operation: "down",
        _tag: "SessionAbsent",
        sessionName: "myapp-feature",
      },
    ]);
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  });

  test("swallows reporters that throw before returning an Effect", async () => {
    const reporter = {
      event: (_event: WorkspaceReporterEvent) => {
        throw new Error("reporter construction failed");
      },
    };

    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.down({ path: "/tmp/myapp-feature", reporter }),
          ),
          {
            worktree: {
              ...liveWorktreeService,
              isGitRepo: () => Effect.succeed(true),
            },
            tmux: {
              ...liveTmuxService,
              sessionExists: () => Effect.succeed(false),
            },
          },
        ),
      ),
    ).resolves.toMatchObject({ status: "absent" });
  });
});

test("liveWorkspaceService exposes public up and down operations only for this slice", () => {
  expect(typeof liveWorkspaceService.up).toBe("function");
  expect(typeof liveWorkspaceService.down).toBe("function");
  expect("open" in liveWorkspaceService).toBe(false);
  expect("close" in liveWorkspaceService).toBe(false);
});

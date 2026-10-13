import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { rootCommand } from "../src/cli/root-command";
import { runBunPromise } from "../src/effect/runtime";
import { liveSetupService } from "../src/services/setup-service";
import { WorkspaceService } from "../src/services/workspace-service";
import { liveWorktreeService } from "../src/services/worktree-service";
import { noopTmuxService, withTestServices } from "./helpers/services";

describe("Workspace Operation profile validation", () => {
  let root: string;
  let main: string;
  let worktreePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "wct-profile-validation-"));
    main = join(root, "main");
    worktreePath = join(root, "worktrees", "demo-feature");
    await mkdir(main);
    await mkdir(join(root, "home"));
    vi.stubEnv("HOME", join(root, "home"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(profiles: string) {
    await Bun.write(
      join(main, ".wct.yaml"),
      `project_name: demo
worktree_dir: ../worktrees
copy: [.env]
setup:
  - name: setup
    command: touch lifecycle-ran
down:
  - name: down
    command: touch lifecycle-ran
tmux:
  windows:
    - name: main
${profiles}`,
    );
    await Bun.write(join(main, ".env"), "SECRET=fixture\n");
  }

  function guardedServices(branch: string | null = "feature") {
    const createWorktree = vi.fn(() => Effect.die("must not create worktree"));
    const removeWorktree = vi.fn(() => Effect.die("must not remove worktree"));
    const runSetupCommands = vi.fn(() => Effect.die("must not run setup"));
    const createSession = vi.fn(() => Effect.die("must not create session"));
    const killSession = vi.fn(() => Effect.die("must not kill session"));
    const services = {
      worktree: {
        ...liveWorktreeService,
        isGitRepo: () => Effect.succeed(true),
        getWorktreeRoot: (path?: string) =>
          Effect.succeed(path ?? worktreePath),
        getMainRepoPath: () => Effect.succeed(main),
        getCurrentBranch: () => Effect.succeed(branch),
        findWorktreeByBranch: (name: string) =>
          Effect.succeed({
            path: worktreePath,
            branch: name,
            commit: "abc",
            isBare: false,
          }),
        createWorktree,
        removeWorktree,
      },
      setup: { ...liveSetupService, runSetupCommands },
      tmux: {
        ...noopTmuxService,
        sessionExists: () => Effect.succeed(true),
        createSession,
        killSession,
      },
    };
    return {
      services,
      calls: [
        createWorktree,
        removeWorktree,
        runSetupCommands,
        createSession,
        killSession,
      ],
    };
  }

  async function expectNoLifecycle(
    calls: ReturnType<typeof guardedServices>["calls"],
  ) {
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(await Bun.file(join(worktreePath, ".env")).exists()).toBe(false);
    expect(await Bun.file(join(worktreePath, "lifecycle-ran")).exists()).toBe(
      false,
    );
  }

  for (const operation of ["open", "up", "down", "close"] as const) {
    test.each([
      ["absent", "", "(none)"],
      ["empty", "profiles: {}\n", "(none)"],
      ["populated", "profiles:\n  matching:\n    match: '*'\n", "matching"],
    ])(
      `${operation} rejects an unknown explicit profile with %s profiles before lifecycle work`,
      async (_kind, profiles, available) => {
        await writeConfig(profiles);
        await mkdir(worktreePath, { recursive: true });
        const { services, calls } = guardedServices();
        const args =
          operation === "open"
            ? ["open", "feature"]
            : operation === "close"
              ? ["close", "feature", "--yes"]
              : [operation, "--path", worktreePath];
        args.push("--profile", "missing", "--json");

        await expect(
          runBunPromise(
            withTestServices(
              Command.runWith(rootCommand, { version: "0.0.0" })(args),
              services,
            ),
          ),
        ).rejects.toMatchObject({
          _tag: "WctCommandError",
          code: "config_error",
          message: `Profile 'missing' not found. Available profiles: ${available}`,
        });
        await expectNoLifecycle(calls);
      },
    );
  }

  test.each(["down", "close"] as const)(
    "%s validates explicit profiles on detached HEAD",
    async (operation) => {
      await writeConfig("");
      const { services, calls } = guardedServices(null);
      await expect(
        runBunPromise(
          withTestServices(
            WorkspaceService.use((service) =>
              service[operation]({ path: worktreePath, profile: "missing" }),
            ),
            services,
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "WctCommandError",
        code: "config_error",
        message: "Profile 'missing' not found. Available profiles: (none)",
      });
      await expectNoLifecycle(calls);
    },
  );

  test.each([
    ["absent", "", "(none)"],
    ["empty", "profiles: {}\n", "(none)"],
    ["populated", "profiles:\n  matching: {}\n", "matching"],
  ])(
    "close rejects unknown explicit profiles for deleted checkouts with %s profiles",
    async (_kind, profiles, available) => {
      await writeConfig(profiles);
      const { services, calls } = guardedServices();
      services.worktree.isGitRepo = () => Effect.succeed(false);
      services.worktree.listWorktrees = () =>
        Effect.succeed([
          {
            path: worktreePath,
            branch: "feature",
            commit: "abc",
            isBare: false,
          },
        ]);

      await expect(
        runBunPromise(
          withTestServices(
            WorkspaceService.use((service) =>
              service.close({
                path: worktreePath,
                cwd: main,
                profile: "missing",
              }),
            ),
            services,
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "WctCommandError",
        code: "config_error",
        message: `Profile 'missing' not found. Available profiles: ${available}`,
      });
      await expectNoLifecycle(calls);
    },
  );

  test("close accepts a known explicit profile for a deleted checkout without running scripts", async () => {
    await writeConfig("profiles:\n  manual: {}\n");
    const { services } = guardedServices();
    const killSession = vi.fn(() => Effect.void);
    const removeWorktree = vi.fn((path: string) =>
      Effect.succeed({ _tag: "Removed" as const, path }),
    );
    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.close({
            path: worktreePath,
            cwd: main,
            profile: "manual",
          }),
        ),
        {
          ...services,
          worktree: {
            ...services.worktree,
            isGitRepo: () => Effect.succeed(false),
            listWorktrees: () =>
              Effect.succeed([
                {
                  path: worktreePath,
                  branch: "feature",
                  commit: "abc",
                  isBare: false,
                },
              ]),
            getMainRepoPath: (cwd?: string) =>
              Effect.sync(() => {
                expect(cwd).toBe(main);
                return main;
              }),
            removeWorktree,
          },
          tmux: { ...services.tmux, killSession },
        },
      ),
    );
    expect(result.status).toBe("removed");
    expect(result.attempts.down).toEqual({
      attempted: false,
      reason: "worktree_missing",
    });
    expect(killSession).toHaveBeenCalledOnce();
    expect(removeWorktree).toHaveBeenCalledOnce();
    expect(await Bun.file(join(worktreePath, "lifecycle-ran")).exists()).toBe(
      false,
    );
  });
});

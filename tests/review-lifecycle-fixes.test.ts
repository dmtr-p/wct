import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { closeCommand } from "../src/commands/close";
import { runBunPromise } from "../src/effect/runtime";
import { runDetachedShutdown } from "../src/services/shutdown-runner";
import { TmuxService } from "../src/services/tmux";
import {
  CurrentWorkspaceLease,
  makeWorkspaceCoordinationService,
} from "../src/services/workspace-coordination";
import { WorkspaceService } from "../src/services/workspace-service";
import {
  assertWorkspaceTarget,
  inspectWorkspaceTarget,
} from "../src/services/workspace-target";
import { liveWorktreeService } from "../src/services/worktree-service";
import {
  legacySession,
  noopTmuxService,
  withTestServices,
} from "./helpers/services";

const fixture = fileURLToPath(
  new URL("./fixtures/review-lifecycle-fixes.ts", import.meta.url),
);
const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
describe("PR369 lifecycle integrity regressions", () => {
  let root: string;
  let repo: string;
  let env: Record<string, string | undefined>;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let writer: number | undefined;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "wct-review-fixes-")));
    repo = join(root, "repo");
    await mkdir(repo);
    await mkdir(join(root, "home"));
    vi.stubEnv("HOME", join(root, "home"));
    await mkdir(join(root, "bin"));
    await Bun.write(
      join(root, "bin/tmux"),
      "#!/bin/sh\necho 'no sessions' >&2\nexit 1\n",
    );
    await chmod(join(root, "bin/tmux"), 0o755);
    env = {
      ...process.env,
      TMUX: "",
      TMUX_PANE: "",
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
    };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_")) delete env[key];
    git(["init", "-b", "main"]);
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
  });
  afterEach(async () => {
    await Bun.write(join(root, "release"), "release descendants");
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    if (writer) {
      try {
        process.kill(writer, "SIGKILL");
      } catch {
        /* Already exited. */
      }
      writer = undefined;
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  function git(args: string[], cwd = repo) {
    const r = Bun.spawnSync(["git", ...args], { cwd, env });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    return r.stdout.toString();
  }
  function spawn(mode: string) {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        fixture,
        mode,
        JSON.stringify({ root, repo, git: Bun.which("git") }),
      ],
      { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
    );
    children.push(child);
    return { child, errors: new Response(child.stderr).text() };
  }
  async function until(path: string) {
    await vi.waitFor(
      async () => expect(await Bun.file(path).exists()).toBe(true),
      { timeout: 5000 },
    );
  }
  async function command(args: string[]) {
    const child = Bun.spawn([process.execPath, "run", cli, ...args], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    const out = new Response(child.stdout).text();
    const err = new Response(child.stderr).text();
    return { code: await child.exited, out: await out, err: await err };
  }

  test.each(["repository-orphan", "repository-partial"])(
    "SIGKILL fences %s until exact repository reconciliation",
    async (mode) => {
      const owner = spawn(mode);
      await until(
        join(root, mode === "repository-orphan" ? "writer" : "partial"),
      );
      if (mode === "repository-orphan")
        writer = Number(await readFile(join(root, "writer"), "utf8"));
      owner.child.kill("SIGKILL");
      await owner.child.exited;
      const status = JSON.parse(
        (await command(["operations", "inspect-repository", "--json"])).out,
      ).data;
      expect(status.status).toBe("outcome-unknown");
      expect(
        JSON.parse(
          (await command(["operations", "inspect", "feature", "--json"])).out,
        ).data.status,
      ).toBe("outcome-unknown");
      const blocked = await command(["open", "other", "--json", "--no-attach"]);
      expect(blocked.code).not.toBe(0);
      expect(blocked.err).toContain(status.reservation.operationId);
      if (writer) expect(() => process.kill(writer ?? 0, 0)).not.toThrow();
      await Bun.write(join(root, "release"), "allow old writer");
      if (writer)
        await vi.waitFor(() =>
          expect(git(["config", "--get", "review.orphan"]).trim()).toBe(
            "old-owner",
          ),
        );
      const recovery = [
        "operations",
        "reconcile-repository",
        "--json",
        "--operation",
        status.reservation.operationId,
        "--generation",
        status.reservation.generation,
        "--acknowledge-uncertain-side-effects",
        "--reason",
        "Inspected orphan and partial Git intent",
      ];
      const stale = [...recovery];
      stale[stale.indexOf("--generation") + 1] = "stale";
      expect((await command(stale)).code).not.toBe(0);
      expect((await command(recovery)).code).toBe(0);
      expect((await command(recovery)).code).not.toBe(0);
      expect(
        (await command(["open", "other", "--json", "--no-attach"])).code,
      ).toBe(0);
    },
    15000,
  );

  test("known Git nonzero completion does not fence either lease", async () => {
    const owner = spawn("repository-known-error");
    expect(await owner.child.exited, await owner.errors).toBe(0);
    expect(
      JSON.parse(
        (await command(["operations", "inspect-repository", "--json"])).out,
      ).data.status,
    ).toBe("available");
    expect(
      JSON.parse(
        (await command(["operations", "inspect", "feature", "--json"])).out,
      ).data.status,
    ).toBe("available");
  });

  test.each([
    "worker-publication-failure",
    "worker-finalization-failure",
    "worker-lost-completed",
  ])(
    "worker completion proof handles %s",
    async (mode) => {
      const result = await runBunPromise(
        withTestServices(
          Effect.scoped(
            Effect.gen(function* () {
              const service = yield* makeWorkspaceCoordinationService();
              const lease = yield* service.acquire({
                mainRepoPath: repo,
                branch: "feature",
              });
              return yield* Effect.result(
                runDetachedShutdown(
                  {
                    operation: "down",
                    worktreePath: repo,
                    sessionTarget: {
                      mainRepoPath: repo,
                      branch: "feature",
                      worktreePath: repo,
                    },
                    cwd: repo,
                  },
                  undefined,
                  {
                    workerCommand: (directory) => [
                      process.execPath,
                      "run",
                      fixture,
                      mode,
                      JSON.stringify({ root, repo, directory }),
                    ],
                  },
                ).pipe(Effect.provideService(CurrentWorkspaceLease, lease)),
              );
            }),
          ),
        ),
      );
      if (mode === "worker-lost-completed") expect(result._tag).toBe("Success");
      else expect(result._tag).toBe("Failure");
    },
    15000,
  );

  test.each(["bare", "separate"])(
    "missing checkout retry retains actual %s Git registration",
    async (layout) => {
      if (layout === "bare") {
        const bare = join(root, "bare.git");
        git(["clone", "--bare", repo, bare]);
        repo = bare;
      } else {
        const separated = join(root, "separated");
        git([
          "clone",
          "--separate-git-dir",
          join(root, "metadata"),
          repo,
          separated,
        ]);
        repo = separated;
      }
      const path = join(root, "checkout");
      git(["worktree", "add", "-b", "feature", path]);
      const expected = await runBunPromise(
        withTestServices(inspectWorkspaceTarget(path)),
      );
      await rm(path, { recursive: true });
      // An unrelated registration may disappear between directory enumeration and read.
      await mkdir(
        join(
          git(["rev-parse", "--git-common-dir"]).trim().startsWith("/")
            ? git(["rev-parse", "--git-common-dir"]).trim()
            : join(repo, git(["rev-parse", "--git-common-dir"]).trim()),
          "worktrees",
          "disappearing",
        ),
      );
      await runBunPromise(
        withTestServices(
          assertWorkspaceTarget(expected, { removalOnly: true }),
        ),
      );
    },
  );

  test("removal revalidates inside repository custody after waiting", async () => {
    const path = join(root, "checkout");
    git(["worktree", "add", "-b", "feature", path]);
    await Bun.write(join(path, "dirty"), "keep");
    const previous = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.close({ path, cwd: repo })),
      ),
    );
    const holder = spawn("repository-holder");
    await until(join(root, "acquired"));
    const removing = Promise.withResolvers<void>();
    const retry = runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.retryCloseRemoval(previous, {
            reporter: {
              event: (event) =>
                Effect.sync(() => {
                  if (
                    event._tag === "PhaseStarted" &&
                    event.phase._tag === "RemovingWorktree"
                  )
                    removing.resolve();
                }),
            },
          }),
        ),
      ),
    );
    void retry.catch(() => undefined);
    await removing.promise;
    // Wait until a fresh independent connection observes both custodians.
    await vi.waitFor(async () =>
      expect(
        JSON.parse(
          (await command(["operations", "inspect", "feature", "--json"])).out,
        ).data.reservation.phase,
      ).toBe("owned"),
    );
    git(["worktree", "remove", "--force", path]);
    git(["worktree", "add", path, "feature"]);
    await Bun.write(join(path, "replacement"), "keep");
    await Bun.write(join(root, "release-holder"), "release repository lock");
    expect(await holder.child.exited, await holder.errors).toBe(0);
    await expect(retry).rejects.toThrow("changed");
    expect(await Bun.file(join(path, "replacement")).text()).toBe("keep");
  }, 15000);

  test("waiting symlink target executes only the validated canonical checkout", async () => {
    const path = join(root, "checkout");
    const other = join(root, "other");
    const alias = join(root, "alias");
    git(["worktree", "add", "-b", "feature", path]);
    git(["worktree", "add", "-b", "other", other]);
    await symlink(path, alias);
    const coordination = await runBunPromise(
      makeWorkspaceCoordinationService(),
    );
    const released = Promise.withResolvers<void>();
    let resolveHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      resolveHeld = resolve;
    });
    const owner = runBunPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* coordination.acquire({
            mainRepoPath: repo,
            branch: "feature",
          });
          resolveHeld();
          yield* Effect.promise(() => released.promise);
        }),
      ),
    );
    await held;
    const waiting = Promise.withResolvers<void>();
    let acted = "";
    const action = runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.down({
            path: alias,
            reporter: {
              event: (event) =>
                Effect.sync(() => {
                  if (
                    event._tag === "PhaseStarted" &&
                    event.phase._tag === "Waiting"
                  )
                    waiting.resolve();
                }),
            },
          }),
        ),
        {
          tmux: {
            ...(await import("./helpers/services")).noopTmuxService,
            resolveSession: (target) =>
              Effect.sync(() => {
                acted = target.worktreePath;
                return null;
              }),
          },
        },
      ),
    );
    await waiting.promise;
    await rm(alias);
    await symlink(other, alias);
    released.resolve();
    await owner;
    await action;
    expect(acted).toBe(path);
  }, 15000);
  test("Close rejects a different branch discovered after branch selection", async () => {
    const path = join(root, "checkout");
    git(["worktree", "add", "-b", "feature", path]);
    await expect(
      runBunPromise(
        withTestServices(
          closeCommand({ branches: ["feature"], yes: true, force: true }),
          {
            worktree: {
              ...liveWorktreeService,
              getMainRepoPath: () => Effect.succeed(repo),
              findWorktreeByBranch: () =>
                Effect.sync(() => {
                  git(["switch", "-c", "replacement"], path);
                  return {
                    path,
                    branch: "feature",
                    commit: "fixture",
                    isBare: false,
                  };
                }),
            },
          },
        ),
      ),
    ).rejects.toThrow("Selected Workspace changed");
    expect(await Bun.file(join(path, ".git")).exists()).toBe(true);
    expect(git(["branch", "--show-current"], path).trim()).toBe("replacement");
  });

  test("test service preserves replacement session IDs and server generations", async () => {
    const target = {
      mainRepoPath: repo,
      branch: "feature",
      worktreePath: repo,
    };
    let current = legacySession(target);
    await runBunPromise(
      withTestServices(
        Effect.gen(function* () {
          const service = yield* TmuxService;
          yield* service.resolveSession(target);
          yield* service.killSession("$1");
          current = { ...current, id: "$2" };
          expect((yield* service.resolveSession(target))?.id).toBe("$2");
          current = { ...current, id: "$1", server: "new-server" };
          expect((yield* service.resolveSession(target))?.server).toBe(
            "new-server",
          );
        }),
        {
          tmux: {
            ...noopTmuxService,
            resolveSession: () => Effect.sync(() => current),
          },
        },
      ),
    );
  });
});

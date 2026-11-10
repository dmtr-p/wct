import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect, PlatformError } from "effect";
import { beforeEach, describe, expect, vi } from "vitest";
import { switchCommand } from "../../src/commands/switch";
import { runBunPromise } from "../../src/effect/runtime";
import { commandError, type WctError } from "../../src/errors";
import { ProcessExitError } from "../../src/services/process";
import {
  canonicalSessionTarget,
  findWorkspaceSession,
  selectWorkspaceSession,
  sessionIdentity,
  workspaceSessionName,
  type WorkspaceSessionTarget,
} from "../../src/services/session-identity";
import { WorkspaceService } from "../../src/services/workspace-service";
import type { WctEnv } from "../../src/types/env";
import { shutdownWorktreeService, withTestServices } from "../helpers/services";
import { test } from "../helpers/temp-dir";

type ExecProcess = typeof import("../../src/services/process").execProcess;
type ExecResult = ReturnType<ExecProcess>;
const exec = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<ExecProcess>
    ) => Effect.Effect<
      Effect.Success<ExecResult>,
      Effect.Error<ExecResult> | WctError,
      Effect.Services<ExecResult>
    >
  >(),
);
vi.mock("../../src/services/process", async () => ({
  ...(await vi.importActual<typeof import("../../src/services/process")>(
    "../../src/services/process",
  )),
  execProcess: (...args: Parameters<ExecProcess>) =>
    Effect.suspend(() => exec(...args)),
}));
const { liveTmuxService, parseSessionVariable } =
  await import("../../src/services/tmux");

const target: WorkspaceSessionTarget = {
  mainRepoPath: "/repos/a",
  branch: "feature/a",
  worktreePath: "/work/a/api",
};
const environment = (value = target): WctEnv => ({
  WCT_MAIN_DIR: value.mainRepoPath,
  WCT_BRANCH: value.branch,
  WCT_WORKTREE_DIR: value.worktreePath,
  WCT_WORK_DIR: value.worktreePath,
  WCT_PROJECT: "api",
});
const owned = (value = target) => ({
  name: workspaceSessionName(value),
  id: "$1",
  server: "server",
  ownership: { identity: sessionIdentity(value) },
});

describe("Workspace session identity", () => {
  test("parses only the requested session variable without splitting multiline values", () => {
    expect(
      parseSessionVariable(
        "WCT_MAIN_DIR",
        "WCT_MAIN_DIR=/repo\nWCT_BRANCH=other\n",
      ),
    ).toBe("/repo\nWCT_BRANCH=other");
    expect(parseSessionVariable("WCT_BRANCH", "-WCT_BRANCH\n")).toBeUndefined();
    expect(() =>
      parseSessionVariable("WCT_BRANCH", "OTHER=x\nWCT_BRANCH=feature\n"),
    ).toThrow("Malformed");
  });

  test("distinguishes repositories and sanitized branch prefixes deterministically", () => {
    expect(workspaceSessionName(target)).toMatch(/^api-[0-9a-f]{10}$/);
    expect(workspaceSessionName({ ...target })).toBe(
      workspaceSessionName(target),
    );
    expect(
      workspaceSessionName({ ...target, mainRepoPath: "/repos/b" }),
    ).not.toBe(workspaceSessionName(target));
    expect(workspaceSessionName({ ...target, branch: "feature-a" })).not.toBe(
      workspaceSessionName(target),
    );
    expect(Buffer.from(sessionIdentity(target), "base64").toString()).toBe(
      "/repos/a\0feature/a",
    );
  });

  test("canonicalizes symlinks, including deleted checkout descendants", async ({
    tempDir: root,
  }) => {
    await mkdir(join(root, "repo"));
    await symlink(join(root, "repo"), join(root, "alias"));
    const canonical = await runBunPromise(
      canonicalSessionTarget({
        ...target,
        mainRepoPath: join(root, "repo"),
        worktreePath: join(root, "repo", "deleted"),
      }),
    );
    const alias = await runBunPromise(
      canonicalSessionTarget({
        ...target,
        mainRepoPath: join(root, "alias"),
        worktreePath: join(root, "alias", "deleted"),
      }),
    );
    expect(alias).toEqual(canonical);
    expect(workspaceSessionName(alias)).toBe(workspaceSessionName(canonical));
  });

  test("rejects a forced name/hash collision and does not attribute foreign panes", () => {
    const foreign = {
      ...owned({ ...target, mainRepoPath: "/repos/b" }),
      name: workspaceSessionName(target),
    };
    expect(selectWorkspaceSession([foreign], target).type).toBe("conflict");
    expect(findWorkspaceSession([foreign], target)).toBeUndefined();
    expect(
      findWorkspaceSession([{ name: workspaceSessionName(target) }], target),
    ).toBeUndefined();
  });

  test("rejects duplicate owned sessions", () => {
    expect(
      selectWorkspaceSession(
        [owned(), { ...owned(), name: "api", id: "$2" }],
        target,
      ).type,
    ).toBe("conflict");
  });

  test.each([
    { mainRepoPath: "/repos/b" },
    { worktreePath: "/work/b/api" },
    {
      mainRepoPath: "/repos/b",
      worktreePath: "/work/b/api",
      branch: target.branch,
      identity: "corrupt",
    },
  ])("does not ignore unverified foreign legacy metadata", (ownership) => {
    expect(
      selectWorkspaceSession([{ ...owned(), name: "api", ownership }], target)
        .type,
    ).toBe("conflict");
  });
});

describe("verified tmux session lifecycle", () => {
  let sessions: Map<string, { name: string; env: Record<string, string> }>;
  let killed: string[];
  let failConstruction: boolean;
  let failAcquisition: boolean;
  let server: string;

  beforeEach(() => {
    sessions = new Map();
    killed = [];
    failConstruction = false;
    failAcquisition = false;
    server = "socket|10|20";
    exec.mockReset();
    exec.mockImplementation((_command, args = []) => {
      const ok = (stdout = "") =>
        Effect.succeed({ stdout, stderr: "", exitCode: 0 });
      const id = args[args.indexOf("-t") + 1] ?? "";
      if (args[0] === "list-sessions")
        return ok(
          [...sessions]
            .map(([id, session]) => `${session.name}:0:1\t${id}\t${server}`)
            .join("\n"),
        );
      if (args[0] === "show-environment") {
        const session = sessions.get(id);
        const key = args[3] ?? "";
        return session
          ? ok(
              key in session.env ? `${key}=${session.env[key]}\n` : `-${key}\n`,
            )
          : Effect.fail(commandError("tmux_error", "session vanished"));
      }
      if (args[0] === "new-session") {
        if (failAcquisition)
          return Effect.fail(commandError("tmux_error", "duplicate session"));
        const env: Record<string, string> = {};
        args.forEach((arg, i) => {
          if (args[i - 1] !== "-e") return;
          const equal = arg.indexOf("=");
          env[arg.slice(0, equal)] = arg.slice(equal + 1);
        });
        sessions.set("$3", { name: args[args.indexOf("-s") + 1] ?? "", env });
        return ok("$3\n");
      }
      if (args[0] === "set-environment") {
        if (failConstruction)
          return Effect.fail(commandError("tmux_error", "construction failed"));
        const session = sessions.get(id);
        const key = args[3];
        if (session && key) session.env[key] = args[4] ?? "";
        return ok();
      }
      if (args[0] === "kill-session") {
        killed.push(id);
        sessions.delete(id);
        return ok();
      }
      return ok();
    });
  });

  test.each(["no sessions", "no server running on socket"])(
    "treats %s as absence",
    async (stderr) => {
      exec.mockReturnValueOnce(
        Effect.fail(
          new ProcessExitError({
            command: "tmux",
            args: ["list-sessions"],
            stdout: "",
            stderr,
            exitCode: 1,
          }),
        ),
      );
      expect(
        await runBunPromise(liveTmuxService.resolveSession(target)),
      ).toBeNull();
    },
  );

  test("inspection failures cannot be mistaken for absence", async () => {
    exec.mockReturnValueOnce(
      Effect.fail(
        new ProcessExitError({
          command: "tmux",
          args: ["list-sessions"],
          stdout: "",
          stderr: "permission denied",
          exitCode: 1,
        }),
      ),
    );
    await expect(
      runBunPromise(liveTmuxService.resolveSession(target)),
    ).rejects.toThrow("permission denied");
    expect(killed).toEqual([]);
  });

  test.for(["down", "close"] as const)(
    "%s runs cleanup without a tmux executable or configuration",
    async (operation, { tempDir: root }) => {
      const mainRepoPath = join(root, "repo");
      const worktreePath = join(root, "feature");
      await mkdir(mainRepoPath);
      await mkdir(worktreePath);
      await Bun.write(
        join(mainRepoPath, ".wct.yaml"),
        JSON.stringify({
          project_name: "api",
          down: [{ name: "cleanup", command: "printf cleaned > cleanup.txt" }],
        }),
      );
      const removeWorktree = vi.fn((path: string) =>
        Effect.succeed({ _tag: "Removed" as const, path }),
      );
      const which = vi.spyOn(Bun, "which").mockReturnValue(null);
      try {
        exec.mockReturnValue(
          Effect.fail(
            new ProcessExitError({
              command: "tmux",
              args: ["list-sessions"],
              stdout: "",
              stderr: "",
              exitCode: null,
              cause: PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
              }),
            }),
          ),
        );
        const result = await runBunPromise(
          withTestServices(
            WorkspaceService.use((service) =>
              Effect.gen(function* () {
                return operation === "down"
                  ? yield* service.down({ path: worktreePath })
                  : yield* service.close({ path: worktreePath });
              }),
            ),
            {
              worktree: {
                ...shutdownWorktreeService,
                isGitRepo: () => Effect.succeed(true),
                getMainRepoPath: () => Effect.succeed(mainRepoPath),
                removeWorktree,
              },
              tmux: liveTmuxService,
            },
          ),
        );
        expect(result.attempts.kill).toEqual({
          attempted: false,
          reason: "session_absent",
        });
        expect(result.attempts.down).toMatchObject({
          attempted: true,
          ok: true,
        });
        expect(await Bun.file(join(worktreePath, "cleanup.txt")).text()).toBe(
          "cleaned",
        );
        expect(removeWorktree).toHaveBeenCalledTimes(
          operation === "close" ? 1 : 0,
        );
        expect(killed).toEqual([]);
      } finally {
        which.mockRestore();
      }
    },
  );

  test.each([
    { tag: "PermissionDenied" as const, executable: null },
    { tag: "NotFound" as const, executable: "/usr/bin/tmux" },
  ])(
    "does not hide other spawn failures: $tag",
    async ({ tag, executable }) => {
      const which = vi.spyOn(Bun, "which").mockReturnValue(executable);
      try {
        exec.mockReturnValueOnce(
          Effect.fail(
            new ProcessExitError({
              command: "tmux",
              args: ["list-sessions"],
              stdout: "",
              stderr: "",
              exitCode: null,
              cause: PlatformError.systemError({
                _tag: tag,
                module: "ChildProcess",
                method: "spawn",
              }),
            }),
          ),
        );
        await expect(
          runBunPromise(liveTmuxService.resolveSession(target)),
        ).rejects.toThrow("Failed to run tmux");
        expect(killed).toEqual([]);
      } finally {
        which.mockRestore();
      }
    },
  );

  test("unreadable ownership prevents legacy adoption", async () => {
    sessions.set("$1", { name: "api", env: { ...environment() } });
    const implementation = exec.getMockImplementation();
    if (!implementation) throw new Error("missing tmux fixture");
    exec.mockImplementation((command, args = []) =>
      args[0] === "show-environment" && args[3] === "WCT_WORKSPACE_ID"
        ? Effect.fail(commandError("tmux_error", "cannot inspect ownership"))
        : implementation(command, args),
    );
    await expect(
      runBunPromise(liveTmuxService.resolveSession(target)),
    ).rejects.toThrow("ownership");
    expect(sessions.get("$1")?.env.WCT_WORKSPACE_ID).toBeUndefined();
    expect(killed).toEqual([]);
  });

  test("creates a tagged session and subsequently resolves its ID", async () => {
    const name = workspaceSessionName(target);
    expect(
      await runBunPromise(
        liveTmuxService.createSession(
          name,
          target.worktreePath,
          undefined,
          environment(),
        ),
      ),
    ).toEqual({ _tag: "Created", sessionName: name });
    const session = await runBunPromise(liveTmuxService.resolveSession(target));
    expect(session).toMatchObject({
      name,
      id: "$3",
      ownership: { identity: sessionIdentity(target) },
    });
    expect(
      exec.mock.calls.some(
        ([, args = []]) =>
          args[0] === "new-session" &&
          args.includes(`WCT_WORKSPACE_ID=${sessionIdentity(target)}`),
      ),
    ).toBe(true);
  });

  test("adopts a verified legacy session in place, without creating a duplicate", async () => {
    sessions.set("$1", { name: "api", env: { ...environment() } });
    const result = await runBunPromise(
      liveTmuxService.createSession(
        workspaceSessionName(target),
        target.worktreePath,
        undefined,
        environment(),
      ),
    );
    expect(result).toEqual({ _tag: "AlreadyExists", sessionName: "api" });
    expect(sessions.get("$1")?.env.WCT_WORKSPACE_ID).toBe(
      sessionIdentity(target),
    );
    expect(
      exec.mock.calls.some(([, args = []]) => args[0] === "new-session"),
    ).toBe(false);
  });

  test.each([
    { ...target, mainRepoPath: "/repos/b", worktreePath: "/work/b/api" },
    { ...target, worktreePath: "/work/b/api" },
  ])(
    "ignores a verified legacy session belonging to another Workspace",
    async (foreign) => {
      const foreignEnv = { ...environment(foreign) };
      sessions.set("$1", { name: "api", env: { ...foreignEnv } });
      expect(
        await runBunPromise(liveTmuxService.resolveSession(target)),
      ).toBeNull();
      const worktree = {
        ...shutdownWorktreeService,
        isGitRepo: () => Effect.succeed(true),
        getMainRepoPath: () => Effect.succeed(target.mainRepoPath),
        getCurrentBranch: () => Effect.succeed(target.branch),
        removeWorktree: (path: string) =>
          Effect.succeed({ _tag: "Removed" as const, path }),
      };
      const down = await runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.down({ path: target.worktreePath }),
          ),
          { worktree, tmux: liveTmuxService },
        ),
      );
      expect(down.status).toBe("absent");
      const close = await runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.close({ path: target.worktreePath }),
          ),
          { worktree, tmux: liveTmuxService },
        ),
      );
      expect(close.status).toBe("removed");
      expect(
        await runBunPromise(
          liveTmuxService.createSession(
            workspaceSessionName(target),
            target.worktreePath,
            undefined,
            environment(),
          ),
        ),
      ).toEqual({ _tag: "Created", sessionName: workspaceSessionName(target) });
      expect(sessions.get("$1")).toEqual({ name: "api", env: foreignEnv });
      expect(killed).toEqual([]);
    },
  );

  test.each([
    {},
    { ...environment(), WCT_BRANCH: "other" },
    { ...environment(), WCT_WORKSPACE_ID: "corrupt" },
  ])("leaves ambiguous or foreign legacy sessions untouched", async (env) => {
    sessions.set("$1", { name: "api", env });
    await expect(
      runBunPromise(liveTmuxService.resolveSession(target)),
    ).rejects.toThrow("ownership");
    await expect(
      runBunPromise(
        liveTmuxService.createSession(
          workspaceSessionName(target),
          target.worktreePath,
          undefined,
          environment(),
        ),
      ),
    ).rejects.toThrow("ownership");
    expect(sessions.get("$1")?.env).toEqual(env);
    expect(killed).toEqual([]);
  });

  test("revalidates pinned IDs and server generations across shutdown handoff", async () => {
    sessions.set("$1", {
      name: workspaceSessionName(target),
      env: { ...environment(), WCT_WORKSPACE_ID: sessionIdentity(target) },
    });
    const expected = await runBunPromise(
      liveTmuxService.resolveSession(target),
    );
    const original = sessions.get("$1");
    if (!original) throw new Error("missing fixture");
    sessions.delete("$1");
    sessions.set("$2", original);
    await expect(
      runBunPromise(liveTmuxService.resolveSession(target, expected)),
    ).rejects.toThrow("changed after resolution");
    sessions.delete("$2");
    sessions.set("$1", original);
    server = "socket|11|21";
    await expect(
      runBunPromise(liveTmuxService.resolveSession(target, expected)),
    ).rejects.toThrow("changed after resolution");
    expect(killed).toEqual([]);
  });

  test("finds the owned checkout session after HEAD becomes detached", async () => {
    sessions.set("$1", {
      name: workspaceSessionName(target),
      env: { ...environment(), WCT_WORKSPACE_ID: sessionIdentity(target) },
    });
    expect(
      await runBunPromise(
        liveTmuxService.resolveSession({ ...target, branch: "" }),
      ),
    ).toMatchObject({ id: "$1" });
  });

  test("CLI switching and Workspace shutdown use the same verified session ID", async () => {
    sessions.set("$1", { name: "api", env: { ...environment() } });
    const worktree = {
      ...shutdownWorktreeService,
      getMainRepoPath: () => Effect.succeed(target.mainRepoPath),
      getCurrentBranch: () => Effect.succeed(target.branch),
      isGitRepo: () => Effect.succeed(true),
      findWorktreeByBranch: () =>
        Effect.succeed({
          path: target.worktreePath,
          branch: target.branch,
          commit: "abc",
          isBare: false,
        }),
    };
    try {
      vi.stubEnv("TMUX", "socket,10,0");
      vi.stubEnv("TMUX_PANE", "");
      await runBunPromise(
        withTestServices(switchCommand(target.branch), {
          worktree,
          tmux: liveTmuxService,
        }),
      );
      expect(
        exec.mock.calls.some(
          ([, args = []]) => args[0] === "switch-client" && args[2] === "$1",
        ),
      ).toBe(true);
      const down = await runBunPromise(
        withTestServices(
          WorkspaceService.use((service) =>
            service.down({ path: target.worktreePath }),
          ),
          { worktree, tmux: liveTmuxService },
        ),
      );
      expect(down).toMatchObject({ sessionName: "api", status: "killed" });
      expect(killed).toEqual(["$1"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("does not roll back a session when acquisition fails", async () => {
    failAcquisition = true;
    await expect(
      runBunPromise(
        liveTmuxService.createSession(
          workspaceSessionName(target),
          target.worktreePath,
          undefined,
          environment(),
        ),
      ),
    ).rejects.toThrow("duplicate session");
    expect(killed).toEqual([]);
  });

  test("rolls back only the ID returned by successful acquisition", async () => {
    failConstruction = true;
    await expect(
      runBunPromise(
        liveTmuxService.createSession(
          workspaceSessionName(target),
          target.worktreePath,
          undefined,
          environment(),
        ),
      ),
    ).rejects.toThrow("construction failed");
    expect(killed).toEqual(["$3"]);
  });
});

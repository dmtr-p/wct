import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { rootCommand } from "../src/cli/root-command";
import { closeCommand } from "../src/commands/close";
import { downCommand } from "../src/commands/down";
import { loadConfig, resolveProfile } from "../src/config/loader";
import type { WctConfig } from "../src/config/schema";
import { validateConfig } from "../src/config/validator";
import { runBunPromise } from "../src/effect/runtime";
import { commandError } from "../src/errors";
import {
  type WorkspaceCloseResult,
  type WorkspaceReporterEvent,
  WorkspaceService,
} from "../src/services/workspace-service";
import {
  noopTmuxService,
  shutdownWorktreeService,
  withTestServices,
} from "./helpers/services";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe("down scripts", () => {
  let root: string;
  let main: string;
  let worktreePath: string;
  let tracePath: string;
  let sessionExists: boolean;
  let blockRemoval: boolean;
  let branch: string | null;
  let events: WorkspaceReporterEvent[];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "wct-down-scripts-")));
    main = join(root, "main");
    worktreePath = join(root, "feature");
    tracePath = join(root, "trace");
    await mkdir(main);
    await mkdir(join(root, "home"));
    await mkdir(join(worktreePath, "app"), { recursive: true });
    await Bun.write(tracePath, "");
    vi.stubEnv("HOME", join(root, "home"));
    sessionExists = true;
    blockRemoval = false;
    branch = "feature/demo";
    events = [];
    await config({ down: [] });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function config(value: WctConfig) {
    await Bun.write(
      join(main, ".wct.yaml"),
      JSON.stringify({ project_name: "demo", work_dir: "app", ...value }),
    );
  }

  const record = (label: string) =>
    Effect.tryPromise({
      try: () => appendFile(tracePath, `${label}\n`),
      catch: (error) =>
        commandError("unexpected_error", "Failed to record operation", error),
    });

  function script(label: string, extra = "") {
    return {
      name: label,
      command: `printf '%s\\n' ${shellQuote(label)} >> ${shellQuote(tracePath)}${extra}`,
    };
  }

  function overrides() {
    return {
      worktree: {
        ...shutdownWorktreeService,
        isGitRepo: () => Effect.succeed(true),
        getMainRepoPath: () => Effect.succeed(main),
        getCurrentBranch: () => Effect.succeed(branch),
        findWorktreeByBranch: (name: string) =>
          Effect.succeed({
            path: worktreePath,
            branch: name,
            commit: "abc",
            isBare: false,
          }),
        removeWorktree: (path: string, force?: boolean) =>
          Effect.gen(function* () {
            yield* record(force ? "remove-force" : "remove");
            return blockRemoval && !force
              ? { _tag: "BlockedByChanges" as const, path }
              : { _tag: "Removed" as const, path };
          }),
      },
      tmux: {
        ...noopTmuxService,
        sessionExists: () => Effect.succeed(sessionExists),
        killSession: () =>
          record("kill").pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                sessionExists = false;
              }),
            ),
          ),
      },
    };
  }

  function operation(
    kind: "down" | "close",
    options: { profile?: string; force?: boolean } = {},
  ) {
    return WorkspaceService.use((service) =>
      Effect.gen(function* () {
        const workspaceOptions = {
          path: worktreePath,
          ...options,
          reporter: {
            event: (event: WorkspaceReporterEvent) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        };
        if (kind === "down") return yield* service.down(workspaceOptions);
        return yield* service.close(workspaceOptions);
      }),
    );
  }

  async function trace() {
    return (await Bun.file(tracePath).text())
      .trim()
      .split("\n")
      .filter(Boolean);
  }

  test.each(["down", "close"] as const)(
    "%s kills tmux before scripts and runs scripts in order",
    async (kind) => {
      await config({ down: [script("first"), script("second")] });
      const result = await runBunPromise(
        withTestServices(operation(kind), overrides()),
      );
      expect(await trace()).toEqual(
        kind === "down"
          ? ["kill", "first", "second"]
          : ["kill", "first", "second", "remove"],
      );
      expect(result.attempts.down).toEqual({
        attempted: true,
        ok: true,
        value: [
          { name: "first", _tag: "Succeeded" },
          { name: "second", _tag: "Succeeded" },
        ],
      });
      const phases = events
        .filter((event) => event._tag === "PhaseStarted")
        .map((event) => event.phase._tag);
      expect(phases).toEqual(
        kind === "down"
          ? ["Preparing", "StoppingTmuxSession", "RunningDown", "RunningDown"]
          : [
              "Preparing",
              "StoppingTmuxSession",
              "RunningDown",
              "RunningDown",
              "RemovingWorktree",
            ],
      );
      expect(
        events.filter((event) => event._tag === "DownCommandStarted"),
      ).toMatchObject([
        { operation: kind, name: "first", current: 1, total: 2 },
        { operation: kind, name: "second", current: 2, total: 2 },
      ]);
    },
  );

  test.each(["down", "close"] as const)(
    "%s runs scripts without a tmux session",
    async (kind) => {
      sessionExists = false;
      await config({ down: [script("cleanup")] });
      const result = await runBunPromise(
        withTestServices(operation(kind), overrides()),
      );
      expect(await trace()).toEqual(
        kind === "down" ? ["cleanup"] : ["cleanup", "remove"],
      );
      expect(result.attempts.kill).toEqual({
        attempted: false,
        reason: "session_absent",
      });
    },
  );

  test("uses work_dir and the same WCT environment as setup", async () => {
    const output = join(root, "environment");
    await config({
      down: [
        {
          name: "environment",
          command: `printf '%s\\n' "$PWD" "$WCT_WORK_DIR" "$WCT_WORKTREE_DIR" "$WCT_MAIN_DIR" "$WCT_BRANCH" "$WCT_PROJECT" "$WCT_TEST_INHERITED" > ${shellQuote(output)}`,
        },
      ],
    });
    vi.stubEnv("WCT_TEST_INHERITED", "inherited");
    await runBunPromise(withTestServices(operation("down"), overrides()));
    expect((await Bun.file(output).text()).trim().split("\n")).toEqual([
      join(worktreePath, "app"),
      join(worktreePath, "app"),
      worktreePath,
      main,
      branch,
      "demo",
      "inherited",
    ]);
  });

  test.each(["down", "close"] as const)(
    "%s attempts every script and aggregates required failures",
    async (kind) => {
      await config({
        down: [
          script("first", "; exit 1"),
          { ...script("optional", "; exit 2"), optional: true },
          script("last", "; exit 3"),
          script("after"),
        ],
      });
      const failure = await runBunPromise(
        withTestServices(
          operation(kind, { force: true }).pipe(
            Effect.match({
              onSuccess: () => null,
              onFailure: (error) => ({
                code: error.code,
                message: error.message,
              }),
            }),
          ),
          overrides(),
        ),
      );
      expect(failure).toMatchObject({ code: "down_failed" });
      expect(failure?.message).toContain("first:");
      expect(failure?.message).toContain("last:");
      expect(failure?.message).toContain("optional (optional):");
      expect(await trace()).toEqual([
        "kill",
        "first",
        "optional",
        "last",
        "after",
      ]);
      expect((await stat(worktreePath)).isDirectory()).toBe(true);
      expect(events).toContainEqual({
        operation: kind,
        _tag: "AttemptCompleted",
        attempt: "down",
        ok: false,
      });
      expect(
        events.some(
          (event) =>
            event._tag === "PhaseStarted" &&
            event.phase._tag === "RemovingWorktree",
        ),
      ).toBe(false);
    },
  );

  test("optional failures warn and permit close removal", async () => {
    await config({
      down: [
        { ...script("optional", "; exit 2"), optional: true },
        script("after"),
      ],
    });
    const result = await runBunPromise(
      withTestServices(operation("close"), overrides()),
    );
    expect(result.status).toBe("removed");
    expect(await trace()).toEqual(["kill", "optional", "after", "remove"]);
    expect(result.warnings).toMatchObject([
      {
        _tag: "DownFailed",
        operation: "close",
        name: "optional",
        optional: true,
        error: { code: "optional_down_failed" },
      },
    ]);
  });

  test("tmux kill failure prevents scripts and removal", async () => {
    await config({ down: [script("cleanup")] });
    const services = overrides();
    services.tmux.killSession = () =>
      Effect.fail(commandError("tmux_error", "kill failed"));
    await expect(
      runBunPromise(withTestServices(operation("close"), services)),
    ).rejects.toThrow("kill failed");
    expect(await trace()).toEqual([]);
  });

  test("invalid configuration and unknown profiles fail before tmux shutdown", async () => {
    await Bun.write(
      join(main, ".wct.yaml"),
      "down:\n  - name: missing command\n",
    );
    await expect(
      runBunPromise(withTestServices(operation("down"), overrides())),
    ).rejects.toThrow("down[0].command");
    await config({ down: [script("cleanup")] });
    await expect(
      runBunPromise(
        withTestServices(
          operation("close", { profile: "unknown" }),
          overrides(),
        ),
      ),
    ).rejects.toThrow("Profile 'unknown' not found");
    expect(await trace()).toEqual([]);
  });

  test("auto-matches profiles and accepts explicit profile overrides", async () => {
    await config({
      down: [script("base")],
      profiles: {
        matching: {
          match: "feature/*",
          work_dir: ".",
          down: [script("matched")],
        },
        manual: { down: [script("manual")] },
      },
    });
    await runBunPromise(withTestServices(operation("down"), overrides()));
    await runBunPromise(
      withTestServices(operation("down", { profile: "manual" }), overrides()),
    );
    await runBunPromise(
      withTestServices(operation("down", { profile: "" }), overrides()),
    );
    expect(await trace()).toEqual(["kill", "matched", "manual", "base"]);
  });

  test("detached HEAD uses base scripts unless explicitly selecting a profile", async () => {
    branch = null;
    await config({
      down: [script("base", '; test -z "$WCT_BRANCH"')],
      profiles: {
        matching: { match: "*", down: [script("matched")] },
      },
    });
    await runBunPromise(withTestServices(operation("down"), overrides()));
    await runBunPromise(
      withTestServices(operation("down", { profile: "matching" }), overrides()),
    );
    expect(await trace()).toEqual(["kill", "base", "matched"]);
  });

  test("separate down and close calls rerun scripts", async () => {
    await config({ down: [script("cleanup")] });
    await runBunPromise(withTestServices(operation("down"), overrides()));
    await runBunPromise(withTestServices(operation("close"), overrides()));
    expect(await trace()).toEqual(["kill", "cleanup", "cleanup", "remove"]);
  });

  test("removal-only retry preserves shutdown results and does not rerun scripts", async () => {
    blockRemoval = true;
    await config({ down: [script("cleanup")] });
    const services = overrides();
    const remove = vi.spyOn(services.worktree, "removeWorktree");
    const resolveMain = vi.spyOn(services.worktree, "getMainRepoPath");
    const previous = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) =>
          service.close({ path: worktreePath }),
        ),
        services,
      ),
    );
    expect(previous.status).toBe("blocked_by_changes");
    const result = await runBunPromise(
      withTestServices(
        WorkspaceService.use((service) => service.retryCloseRemoval(previous)),
        services,
      ),
    );
    expect(result.status).toBe("removed");
    expect(resolveMain).toHaveBeenLastCalledWith(worktreePath);
    expect(remove).toHaveBeenLastCalledWith(worktreePath, true, main);
    expect(result.attempts.down).toEqual(previous.attempts.down);
    expect(result.attempts.kill).toEqual(previous.attempts.kill);
    expect(result.existed).toBe(true);
    expect(await trace()).toEqual([
      "kill",
      "cleanup",
      "remove",
      "remove-force",
    ]);
    await expect(
      runBunPromise(
        withTestServices(
          WorkspaceService.use((service) => service.retryCloseRemoval(result)),
          overrides(),
        ),
      ),
    ).rejects.toThrow("blocked by changes");
  });

  test("CLI force-removal retry runs scripts once", async () => {
    blockRemoval = true;
    await config({ down: [script("cleanup")] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runBunPromise(
      withTestServices(
        closeCommand({ branches: ["feature/demo"], yes: true }),
        { ...overrides(), json: true },
      ),
    );
    expect(await trace()).toEqual([
      "kill",
      "cleanup",
      "remove",
      "remove-force",
    ]);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]))
      .data[0] as WorkspaceCloseResult;
    expect(result.status).toBe("removed");
    expect(result.existed).toBe(true);
    expect(result.attempts.down).toMatchObject({ attempted: true, ok: true });
  });

  test("missing worktree directories skip scripts and still remove registrations", async () => {
    await config({ down: [script("cleanup")] });
    await rm(worktreePath, { recursive: true });
    const services = overrides();
    services.worktree.isGitRepo = () => Effect.succeed(false);
    services.worktree.listWorktrees = () =>
      Effect.succeed([
        {
          path: worktreePath,
          branch: "feature/demo",
          commit: "abc",
          isBare: false,
        },
      ]);
    services.worktree.getMainRepoPath = () =>
      Effect.die("must not resolve missing worktree config");
    const result = await runBunPromise(
      withTestServices(operation("close"), services),
    );
    expect(result.attempts.down).toEqual({
      attempted: false,
      reason: "worktree_missing",
    });
    expect(await trace()).toEqual(["kill", "remove"]);
  });

  test("global/project/profile lists replace inherited scripts and empty lists disable them", async () => {
    const global = [script("global")];
    await Bun.write(
      join(root, "home", ".wct.yaml"),
      JSON.stringify({ down: global }),
    );
    await config({});
    expect((await runBunPromise(loadConfig(main))).down).toEqual(global);
    const project = [script("project")];
    await config({
      down: project,
      profiles: {
        inherit: {},
        disabled: { down: [] },
        override: { down: [script("profile")] },
      },
    });
    const loaded = await runBunPromise(loadConfig(main));
    expect(loaded.down).toEqual(project);
    expect(resolveProfile(loaded, "feature", "inherit").config.down).toEqual(
      project,
    );
    expect(resolveProfile(loaded, "feature", "disabled").config.down).toEqual(
      [],
    );
    expect(resolveProfile(loaded, "feature", "override").config.down).toEqual([
      script("profile"),
    ]);
    await config({ down: [] });
    expect((await runBunPromise(loadConfig(main))).down).toEqual([]);
    const result = await runBunPromise(
      withTestServices(operation("down"), overrides()),
    );
    expect(result.attempts.down).toEqual({
      attempted: false,
      reason: "down_not_configured",
    });
    expect(await trace()).toEqual(["kill"]);
  });

  test.each(["down", "close"] as const)(
    "%s --profile is parsed by the root CLI",
    async (kind) => {
      await config({
        down: [script("base")],
        profiles: { manual: { down: [script("manual")] } },
      });
      vi.spyOn(console, "log").mockImplementation(() => {});
      const args =
        kind === "down"
          ? ["down", "--path", worktreePath, "--profile", "manual"]
          : ["close", "feature/demo", "--yes", "-P", "manual"];
      await runBunPromise(
        withTestServices(
          Command.runWith(rootCommand, { version: "1.0.0" })(args),
          overrides(),
        ),
      );
      expect(await trace()).toEqual(
        kind === "down" ? ["kill", "manual"] : ["kill", "manual", "remove"],
      );
    },
  );

  test("JSON output is one envelope and captures optional failures without script output", async () => {
    await config({
      down: [
        {
          name: "noisy",
          command: "printf 'script stdout'; printf 'script stderr' >&2; exit 1",
          optional: true,
        },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runBunPromise(
      withTestServices(downCommand({ path: worktreePath }), {
        ...overrides(),
        json: true,
      }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      data: {
        warnings: [{ name: "noisy", error: { message: "script stderr" } }],
        attempts: {
          down: {
            attempted: true,
            ok: true,
            value: [{ name: "noisy", _tag: "OptionalFailed" }],
          },
        },
      },
    });
  });

  test("JSON mode produces no success envelope on required script failure", async () => {
    await config({ down: [{ name: "fail", command: "exit 1" }] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      runBunPromise(
        withTestServices(downCommand({ path: worktreePath }), {
          ...overrides(),
          json: true,
        }),
      ),
    ).rejects.toThrow("Down scripts failed");
    expect(log).not.toHaveBeenCalled();
  });

  test("human CLI reports progress and optional script failures", async () => {
    await config({
      down: [{ name: "fail", command: "exit 1", optional: true }],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runBunPromise(
      withTestServices(downCommand({ path: worktreePath }), overrides()),
    );
    const output = [...log.mock.calls, ...error.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(output).toContain("Down: fail");
    expect(output).toContain("fail failed (optional)");
  });
});

describe("down config validation", () => {
  test("accepts named commands and optional failures in base and profile lists", () => {
    expect(
      validateConfig({
        down: [{ name: "stop", command: "true", optional: true }],
        profiles: { minimal: { down: [] } },
      }).valid,
    ).toBe(true);
  });

  test("renders paths for invalid base and profile down commands", () => {
    const result = validateConfig({
      down: [{ name: "stop" }],
      profiles: {
        bad: { down: [{ name: "stop", command: "true", optional: "yes" }] },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) => error.includes("down[0].command")),
    ).toBe(true);
    expect(
      result.errors.some((error) =>
        error.includes("profiles.bad.down[0].optional"),
      ),
    ).toBe(true);
  });
});

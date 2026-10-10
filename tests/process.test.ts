import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runBunPromise } from "../src/effect/runtime";
import {
  execProcess,
  ProcessExitError,
  ProcessOutputLimitError,
  spawnInteractive,
} from "../src/services/process";

describe("process", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  test("bounded output fails without retaining oversized stdout", async () => {
    let failure: unknown;
    try {
      await runBunPromise(
        execProcess(
          process.execPath,
          ["-e", 'process.stdout.write("x".repeat(300000))'],
          { maxOutputBytes: 1024 },
        ),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProcessExitError);
    expect((failure as ProcessExitError).cause).toBeInstanceOf(
      ProcessOutputLimitError,
    );
    expect((failure as ProcessExitError).stdout).toBe("");
  });

  test("spawnInteractive uses Bun.spawn with inherited stdio", async () => {
    const kill = vi.fn();
    const spawn = vi.spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
      exitCode: 0,
      kill,
    } as unknown as ReturnType<typeof Bun.spawn>);
    const originalSentinel = process.env.SENTINEL_TEST;
    process.env.SENTINEL_TEST = "1";

    try {
      const exitCode = await runBunPromise(
        spawnInteractive("/bin/sh", ["-c", "exit 0"], {
          cwd: "/tmp/worktree",
          env: {
            WCT_BRANCH: "main",
          },
        }),
      );

      expect(exitCode).toBe(0);
      expect(kill).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledWith(["/bin/sh", "-c", "exit 0"], {
        cwd: "/tmp/worktree",
        env: expect.objectContaining({
          WCT_BRANCH: "main",
          SENTINEL_TEST: "1",
        }),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
    } finally {
      if (originalSentinel === undefined) {
        delete process.env.SENTINEL_TEST;
      } else {
        process.env.SENTINEL_TEST = originalSentinel;
      }
    }
  });

  test("spawnInteractive can replace the environment when extendEnv is false", async () => {
    const spawn = vi.spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
      exitCode: 0,
    } as unknown as ReturnType<typeof Bun.spawn>);

    await runBunPromise(
      spawnInteractive("/bin/sh", [], {
        extendEnv: false,
        env: {
          WCT_BRANCH: "feature",
          EMPTY: undefined,
        },
      }),
    );

    expect(spawn).toHaveBeenCalledWith(["/bin/sh"], {
      cwd: undefined,
      env: {
        WCT_BRANCH: "feature",
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  });

  test("spawnInteractive interruption waits for the child to exit", async () => {
    const started = Promise.withResolvers<ReturnType<typeof Bun.spawn>>();
    const spawn = Bun.spawn;
    vi.spyOn(Bun, "spawn").mockImplementation((command, options) => {
      const child = spawn(command, options);
      started.resolve(child);
      return child;
    });
    const fiber = Effect.runFork(
      spawnInteractive(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
    );
    const child = await started.promise;
    let exited = false;
    void child.exited.then(() => {
      exited = true;
    });
    try {
      expect(child.exitCode).toBeNull();
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(exited).toBe(true);
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("spawnInteractive preserves spawn failures in the typed error channel", async () => {
    const failure = new Error("Executable unavailable");
    vi.spyOn(Bun, "spawn").mockImplementation(() => {
      throw failure;
    });
    const error = await Effect.runPromise(
      Effect.flip(spawnInteractive("missing-shell")),
    );
    expect(error).toBe(failure);
  });
});

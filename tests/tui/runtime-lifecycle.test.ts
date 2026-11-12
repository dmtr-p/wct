import { Effect, FileSystem } from "effect";
import { describe, expect, test, vi } from "vitest";
import { WorkspaceService } from "../../src/services/workspace-service";
import {
  createLifecycleClaims,
  type LifecycleState,
  runLifecycleOperation,
} from "../../src/tui/lifecycle";
import { createTuiLifetime, runTuiInvocation } from "../../src/tui/lifetime";
import { createTuiRuntime } from "../../src/tui/runtime";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("tui runtime lifecycle", () => {
  test("idle exit stops rendering and input before disposing once", async () => {
    const events: string[] = [];
    await runTuiInvocation({
      start: () => ({
        waitUntilExit: async () => {},
        unmount: () => {
          events.push("unmount");
        },
      }),
      cleanup: () => {
        events.push("input");
      },
      dispose: async () => {
        events.push("dispose");
      },
    });
    expect(events).toEqual(["unmount", "input", "dispose"]);
  });

  test("repeated quit drains operations and refuses new mutations", async () => {
    const dispose = vi.fn(async () => {});
    const lifetime = createTuiLifetime(dispose);
    const gate = deferred();
    const operation = lifetime.track(() => gate.promise);
    const quit = lifetime.quit();
    expect(lifetime.quit()).toBe(quit);
    const finalization = lifetime.finalize();
    expect(lifetime.finalize()).toBe(finalization);
    await expect(lifetime.track(async () => {})).rejects.toThrow(
      "shutting down",
    );
    expect(dispose).not.toHaveBeenCalled();
    gate.resolve();
    await operation;
    await finalization;
    expect(dispose).toHaveBeenCalledOnce();
  });

  test("operation failure during quit still drains and finalizes", async () => {
    const dispose = vi.fn(async () => {});
    const lifetime = createTuiLifetime(dispose);
    const gate = deferred();
    const operation = lifetime.track(async () => {
      await gate.promise;
      throw new Error("down failed");
    });
    const failure = expect(operation).rejects.toThrow("down failed");
    const done = lifetime.finalize();
    expect(dispose).not.toHaveBeenCalled();
    gate.resolve();
    await failure;
    await done;
    expect(dispose).toHaveBeenCalledOnce();
  });

  test.each(["startup", "render"])(
    "%s failure cleans up and drains before disposal",
    async (phase) => {
      const gate = deferred();
      const dispose = vi.fn(async () => {});
      const cleanup = vi.fn();
      const unmount = vi.fn();
      const failure = new Error(phase);
      const invocation = runTuiInvocation({
        start: (lifetime) => {
          void lifetime.track(() => gate.promise);
          if (phase === "startup") throw failure;
          return {
            waitUntilExit: async () => {
              throw failure;
            },
            unmount,
          };
        },
        cleanup,
        dispose,
      });
      const assertion = expect(invocation).rejects.toBe(failure);
      expect(dispose).not.toHaveBeenCalled();
      gate.resolve();
      await assertion;
      expect(cleanup).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect(unmount).toHaveBeenCalledTimes(phase === "render" ? 1 : 0);
    },
  );

  test("quit waits through lifecycle validation and follow-up handoff", async () => {
    const dispose = vi.fn(async () => {});
    const lifetime = createTuiLifetime(dispose);
    const validation = deferred();
    const handoff = deferred();
    const enteredHandoff = deferred();
    let state: LifecycleState = new Map();
    const operation = runLifecycleOperation({
      claims: createLifecycleClaims(lifetime),
      setLifecycle: (update) => {
        state = typeof update === "function" ? update(state) : update;
      },
      entry: {
        operation: "up",
        repoPath: "/repo",
        project: "repo",
        branch: "main",
        phase: { _tag: "Preparing" },
      },
      run: async () => true,
      refreshAll: async () => {
        await validation.promise;
        return [];
      },
      afterCleanup: async () => {
        enteredHandoff.resolve();
        await handoff.promise;
        return undefined;
      },
      showActionError: vi.fn(),
    });
    const done = lifetime.finalize();
    expect(state.size).toBe(1);
    validation.resolve();
    await enteredHandoff.promise;
    expect(state.size).toBe(0);
    expect(dispose).not.toHaveBeenCalled();
    handoff.resolve();
    await operation;
    await done;
    expect(dispose).toHaveBeenCalledOnce();
  });

  test("provides shared WorkspaceService and platform services per invocation", async () => {
    const runtime = createTuiRuntime();
    try {
      const shape = await runtime.runPromise(
        WorkspaceService.use((service) =>
          Effect.succeed({ up: typeof service.up, down: typeof service.down }),
        ),
      );
      expect(shape).toEqual({ up: "function", down: "function" });
      const filesystem = await runtime.runPromise(FileSystem.FileSystem);
      expect(typeof filesystem.lstat).toBe("function");
    } finally {
      await runtime.dispose();
    }
  });
});

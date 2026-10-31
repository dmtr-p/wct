import { PassThrough } from "node:stream";
import { Effect, Scheduler } from "effect";
import React, { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AGENT_FRESHNESS_MS,
  classifyAgent,
  reconcileAgent,
} from "../../src/services/agent-model";
import {
  AgentService,
  type AgentServiceApi,
  type AgentSnapshot,
  emptyAgentSnapshot,
} from "../../src/services/agent-service";
import { RegistrationId } from "../../src/services/identities";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";

const runPromise = vi.hoisted(() => vi.fn());
vi.mock("../../src/tui/runtime", () => ({ tuiRuntime: { runPromise } }));
const observe = vi.fn<AgentServiceApi["observe"]>();
const { useAgents } = await import("../../src/tui/hooks/useAgents");
const repo: RepoInfo = {
  id: RegistrationId("repo"),
  repoPath: "/repo",
  project: "repo",
  profileNames: [],
  worktrees: [
    {
      path: "/work/workspace",
      branch: "feature",
      isMainWorktree: false,
      changedFiles: 0,
      sync: null,
    },
  ],
};
const cleanups = new Set<() => void>();

function fakeTime() {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
}

function workingSnapshot(): AgentSnapshot {
  return {
    observations: new Map([
      [
        "%1",
        reconcileAgent(
          undefined,
          "codex",
          "g",
          classifyAgent("codex", "", "⠋ busy"),
          Date.now(),
        ),
      ],
    ]),
    memberships: new Map([["workspace", new Set(["%1"])]]),
  };
}

async function renderHook() {
  type HookValue = ReturnType<typeof useAgents>;
  let value: HookValue | undefined;
  let committedValue: HookValue | undefined;
  let repos = [repo];
  let renders = 0;
  const commits = new Set<(next: HookValue) => void>();
  function Wrapper() {
    const next = useAgents(repos);
    value = next;
    renders++;
    useLayoutEffect(() => {
      committedValue = next;
      for (const committed of commits) committed(next);
    });
    return null;
  }
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  stdout.columns = 80;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  const { render } = await import("ink");
  const instance = render(React.createElement(Wrapper), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const unmount = () => {
    instance.unmount();
    cleanups.delete(unmount);
  };
  cleanups.add(unmount);
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(20);
        await new Promise<void>((resolve) => setImmediate(resolve));
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  };
  await flush();
  return {
    get value() {
      if (!value) throw new Error("Missing hook");
      return value;
    },
    get renders() {
      return renders;
    },
    changeTargets: async (next: RepoInfo[] = []) => {
      repos = next;
      instance.rerender(React.createElement(Wrapper));
      await flush();
    },
    unmount,
    flush,
    waitForValue: (predicate: (next: HookValue) => boolean) => {
      if (committedValue && predicate(committedValue)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const committed = (next: HookValue) => {
          if (!predicate(next)) return;
          commits.delete(committed);
          resolve();
        };
        commits.add(committed);
      });
    },
  };
}

describe("scoped agent polling", () => {
  beforeEach(() => {
    observe.mockReset();
    observe.mockReturnValue(Effect.succeed(emptyAgentSnapshot()));
    runPromise.mockReset();
    runPromise.mockImplementation(
      (
        effect: Effect.Effect<unknown, never, AgentServiceApi>,
        options?: { signal?: AbortSignal },
      ) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provideService(AgentService, { observe }),
            Effect.provideService(
              Scheduler.Scheduler,
              new Scheduler.MixedScheduler("sync"),
            ),
          ),
          options,
        ),
    );
  });
  afterEach(async () => {
    for (const cleanup of cleanups) cleanup();
    await Promise.allSettled(
      runPromise.mock.results.map((result) => result.value),
    );
    vi.useRealTimers();
  });
  test("never overlaps observations, ignores obsolete target results, and aborts on unmount", async () => {
    let resolve!: (value: ReturnType<typeof emptyAgentSnapshot>) => void;
    let signal: AbortSignal | undefined;
    observe.mockReturnValueOnce(
      Effect.promise(
        () =>
          new Promise<AgentSnapshot>((done) => {
            resolve = done;
          }),
      ),
    );
    observe.mockReturnValue(
      Effect.promise((currentSignal) => {
        signal = currentSignal;
        return new Promise<AgentSnapshot>(() => {});
      }),
    );
    const harness = await renderHook();
    expect(observe).toHaveBeenCalledTimes(1);
    await harness.changeTargets();
    expect(observe).toHaveBeenCalledTimes(1);
    const agent = reconcileAgent(
      undefined,
      "codex",
      "g",
      classifyAgent("codex", "", "⠋ busy"),
      0,
    );
    resolve({
      observations: new Map([["%1", agent]]),
      memberships: new Map([["workspace", new Set(["%1"])]]),
    });
    await harness.flush();
    expect(harness.value.observations.size).toBe(0);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
    harness.unmount();
    await harness.flush();
    expect(signal?.aborted).toBe(true);
  });
  test("observes every second and suppresses timestamp-only presentation updates", async () => {
    fakeTime();
    const agent = reconcileAgent(
      undefined,
      "codex",
      "g",
      classifyAgent("codex", "", "⠋ busy"),
      Date.now(),
    );
    const snapshot = {
      observations: new Map([["%1", agent]]),
      memberships: new Map([["workspace", new Set(["%1"])]]),
    };
    observe.mockReturnValueOnce(Effect.succeed(snapshot)).mockReturnValue(
      Effect.succeed({
        ...snapshot,
        observations: new Map([
          ["%1", { ...agent, observedAt: agent.observedAt + 1000 }],
        ]),
      }),
    );
    const harness = await renderHook();
    const initialRenders = harness.renders;
    expect(harness.value.summaries.size).toBe(1);
    expect(observe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(850);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(harness.renders).toBe(initialRenders);
    harness.unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(observe).toHaveBeenCalledTimes(2);
  });
  test.each(["stalled", "failing"])(
    "expires visible state while observations are %s",
    async (mode) => {
      fakeTime();
      const agent = reconcileAgent(
        undefined,
        "codex",
        "g",
        classifyAgent("codex", "", "⠋ busy"),
        Date.now(),
      );
      const snapshot = {
        observations: new Map([["%1", agent]]),
        memberships: new Map([["workspace", new Set(["%1"])]]),
      };
      observe
        .mockReturnValueOnce(Effect.succeed(snapshot))
        .mockReturnValue(
          mode === "stalled" ? Effect.never : Effect.die("unavailable"),
        );
      const harness = await renderHook();
      await harness.waitForValue(
        (next) => next.observations.get("%1")?.state === "working",
      );
      expect(harness.value.observations.get("%1")?.state).toBe("working");
      // Timer delivery does not imply that React committed the state update.
      const expired = harness.waitForValue(
        (next) => next.observations.get("%1")?.freshness === "unavailable",
      );
      await vi.advanceTimersByTimeAsync(
        agent.observedAt + AGENT_FRESHNESS_MS - Date.now(),
      );
      await expired;
      if (mode === "stalled") expect(observe).toHaveBeenCalledTimes(2);
      else expect(observe.mock.calls.length).toBeGreaterThan(2);
      expect(harness.value.observations.get("%1")?.freshness).toBe(
        "unavailable",
      );
      expect(harness.value.observations.get("%1")?.state).toBe("unknown");
      harness.unmount();
    },
  );
  test("coalesces a burst during observation and reads the latest targets", async () => {
    fakeTime();
    let resolve!: (snapshot: AgentSnapshot) => void;
    observe.mockReturnValueOnce(
      Effect.promise(
        () =>
          new Promise<AgentSnapshot>((done) => {
            resolve = done;
          }),
      ),
    );
    const harness = await renderHook();
    await harness.changeTargets([]);
    await harness.changeTargets([repo]);
    await harness.changeTargets([]);
    expect(observe).toHaveBeenCalledTimes(1);
    resolve(workingSnapshot());
    await harness.flush();
    expect(observe).toHaveBeenCalledTimes(2);
    expect([...(observe.mock.calls[1]?.[0] ?? [])]).toEqual([]);
    expect(harness.value.observations.size).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(observe).toHaveBeenCalledTimes(2);
  });

  test("starts promptly on an idle target change and cancels the old cadence timer", async () => {
    fakeTime();
    const harness = await renderHook();
    await harness.changeTargets();
    expect(observe).toHaveBeenCalledTimes(2);
    expect([...(observe.mock.calls[1]?.[0] ?? [])]).toEqual([]);
    await vi.advanceTimersByTimeAsync(650);
    expect(observe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(observe).toHaveBeenCalledTimes(3);
  });

  test("slow observations resume without an additional cadence delay", async () => {
    fakeTime();
    let resolve!: (snapshot: AgentSnapshot) => void;
    observe.mockReturnValueOnce(
      Effect.promise(
        () =>
          new Promise<AgentSnapshot>((done) => {
            resolve = done;
          }),
      ),
    );
    const harness = await renderHook();
    await vi.advanceTimersByTimeAsync(2000);
    expect(observe).toHaveBeenCalledTimes(1);
    resolve(emptyAgentSnapshot());
    await harness.flush();
    expect(observe).toHaveBeenCalledTimes(2);
  });

  test("does not reconcile a failure for obsolete targets", async () => {
    fakeTime();
    let reject!: (error: Error) => void;
    observe
      .mockReturnValueOnce(Effect.succeed(workingSnapshot()))
      .mockReturnValueOnce(
        Effect.promise(
          () =>
            new Promise<AgentSnapshot>((_resolve, fail) => {
              reject = fail;
            }),
        ),
      )
      .mockReturnValue(Effect.never);
    const harness = await renderHook();
    await vi.advanceTimersByTimeAsync(850);
    await harness.changeTargets();
    reject(new Error("obsolete observation"));
    await harness.flush();
    expect(observe).toHaveBeenCalledTimes(3);
    expect(harness.value.observations.get("%1")?.freshness).toBe("fresh");
  });

  test("unmount prevents late publication and a remount owns a new worker", async () => {
    fakeTime();
    let resolve!: (snapshot: AgentSnapshot) => void;
    let interrupted = false;
    observe.mockReturnValueOnce(
      Effect.promise((signal) => {
        signal.addEventListener("abort", () => {
          interrupted = true;
        });
        return new Promise<AgentSnapshot>((done) => {
          resolve = done;
        });
      }),
    );
    const harness = await renderHook();
    await harness.changeTargets();
    harness.unmount();
    await harness.flush();
    const renders = harness.renders;
    expect(interrupted).toBe(true);
    observe.mockReturnValue(Effect.never);
    const remounted = await renderHook();
    const remountedRenders = remounted.renders;
    expect(observe).toHaveBeenCalledTimes(2);
    resolve(workingSnapshot());
    await vi.advanceTimersByTimeAsync(6000);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(harness.renders).toBe(renders);
    expect(harness.value.observations.size).toBe(0);
    expect(remounted.renders).toBe(remountedRenders);
    expect(remounted.value.observations.size).toBe(0);
    remounted.unmount();
    await remounted.flush();
  });

  test("unmount cancels an armed expiry and the remounted worker owns its deadline", async () => {
    fakeTime();
    const timers: {
      deadline: number;
      handle: ReturnType<typeof globalThis.setTimeout>;
    }[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const schedule = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((...args) => {
        const handle = originalSetTimeout(...args);
        timers.push({ deadline: Date.now() + (args[1] ?? 0), handle });
        return handle;
      });
    const cancel = vi.spyOn(globalThis, "clearTimeout");
    try {
      const old = workingSnapshot();
      observe
        .mockReturnValueOnce(Effect.succeed(old))
        .mockReturnValue(Effect.never);
      const harness = await renderHook();
      await harness.waitForValue(
        (value) => value.observations.get("%1")?.freshness === "fresh",
      );
      const oldDeadline =
        (old.observations.get("%1")?.observedAt ?? 0) + AGENT_FRESHNESS_MS;
      const expiry = timers.find((timer) => timer.deadline === oldDeadline);
      if (!expiry) throw new Error("Missing expiry timer");
      harness.unmount();
      await harness.flush();
      expect(cancel).toHaveBeenCalledWith(expiry.handle);
      const renders = harness.renders;
      await vi.advanceTimersByTimeAsync(1000);
      const next = workingSnapshot();
      observe.mockReturnValueOnce(Effect.succeed(next));
      const remounted = await renderHook();
      await remounted.waitForValue(
        (value) => value.observations.get("%1")?.freshness === "fresh",
      );
      await vi.advanceTimersByTimeAsync(oldDeadline - Date.now());
      expect(harness.renders).toBe(renders);
      expect(remounted.value.observations.get("%1")?.freshness).toBe("fresh");
      const expired = remounted.waitForValue(
        (value) => value.observations.get("%1")?.freshness === "unavailable",
      );
      const newDeadline =
        (next.observations.get("%1")?.observedAt ?? 0) + AGENT_FRESHNESS_MS;
      await vi.advanceTimersByTimeAsync(newDeadline - Date.now());
      await expired;
      expect(harness.renders).toBe(renders);
    } finally {
      schedule.mockRestore();
      cancel.mockRestore();
    }
  });
});

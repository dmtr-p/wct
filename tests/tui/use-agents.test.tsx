import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { classifyAgent, reconcileAgent } from "../../src/services/agent-model";
import { emptyAgentSnapshot } from "../../src/services/agent-service";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";

const runPromise = vi.hoisted(() => vi.fn());
vi.mock("../../src/tui/runtime", () => ({ tuiRuntime: { runPromise } }));
const { useAgents } = await import("../../src/tui/hooks/useAgents");
const repo: RepoInfo = {
  id: "repo",
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

async function renderHook() {
  let value: ReturnType<typeof useAgents> | undefined;
  let repos = [repo];
  let renders = 0;
  function Wrapper() {
    value = useAgents(repos);
    renders++;
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
    changeTargets: async () => {
      repos = [];
      instance.rerender(React.createElement(Wrapper));
      await flush();
    },
    unmount,
    flush,
  };
}

describe("scoped agent polling", () => {
  beforeEach(() => {
    runPromise.mockReset();
  });
  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    vi.useRealTimers();
  });
  test("never overlaps observations, ignores obsolete target results, and aborts on unmount", async () => {
    let resolve!: (value: ReturnType<typeof emptyAgentSnapshot>) => void;
    runPromise.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    runPromise.mockResolvedValue(emptyAgentSnapshot());
    const harness = await renderHook();
    expect(runPromise).toHaveBeenCalledTimes(1);
    await harness.changeTargets();
    expect(runPromise).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => expect(runPromise).toHaveBeenCalledTimes(2));
    const signal = runPromise.mock.calls[1]?.[1].signal as AbortSignal;
    harness.unmount();
    expect(signal.aborted).toBe(true);
  });
  test("observes every second and suppresses timestamp-only presentation updates", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
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
    runPromise.mockResolvedValueOnce(snapshot).mockResolvedValue({
      ...snapshot,
      observations: new Map([
        ["%1", { ...agent, observedAt: agent.observedAt + 1000 }],
      ]),
    });
    const harness = await renderHook();
    const initialRenders = harness.renders;
    expect(harness.value.summaries.size).toBe(1);
    expect(runPromise).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(850);
    expect(runPromise).toHaveBeenCalledTimes(2);
    expect(harness.renders).toBe(initialRenders);
    harness.unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(runPromise).toHaveBeenCalledTimes(2);
  });
  test("expires visible state even while the next observation is stalled", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
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
    runPromise
      .mockResolvedValueOnce(snapshot)
      .mockImplementation(() => new Promise(() => {}));
    const harness = await renderHook();
    expect(harness.value.observations.get("%1")?.state).toBe("working");
    await vi.advanceTimersByTimeAsync(5000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runPromise).toHaveBeenCalledTimes(2);
    expect(harness.value.observations.get("%1")?.freshness).toBe("unavailable");
    expect(harness.value.observations.get("%1")?.state).toBe("unknown");
    harness.unmount();
  });
});

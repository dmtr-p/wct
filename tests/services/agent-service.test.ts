import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";
import { provideBunServices, runBunPromise } from "../../src/effect/runtime";
import type { ForegroundProcess } from "../../src/services/agent-process";
import {
  type AgentObservationPorts,
  emptyAgentSnapshot,
  makeAgentService,
  observationFailureReason,
} from "../../src/services/agent-service";
import { ProcessOutputLimitError } from "../../src/services/process";
import {
  type AgentPaneMetadata,
  parseAgentPaneMetadata,
} from "../../src/services/tmux";

const pane = (id = "%1", session = "workspace"): AgentPaneMetadata => ({
  server: "socket\0pid\0start",
  paneId: id,
  session,
  tty: `/dev/pts/${id.slice(1)}`,
  initialPid: 10,
  command: "codex",
  title: "⠋ busy",
  width: 80,
  height: 24,
  dead: false,
});
const processFor = (item: AgentPaneMetadata): ForegroundProcess => ({
  pid: 100 + Number(item.paneId.slice(1)),
  ppid: 10,
  pgid: 100,
  tpgid: 100,
  tty: item.tty.replace("/dev/", ""),
  command: item.command,
  stat: "S+",
  started: "start",
});
function fixture(initialPanes = [pane()]) {
  let panes = initialPanes;
  let processes = [
    ...new Map(
      initialPanes.map((item) => [item.paneId, processFor(item)]),
    ).values(),
  ];
  let now = 0;
  const ports: AgentObservationPorts = {
    discover: vi.fn(() => Effect.succeed(panes.map((item) => ({ ...item })))),
    processes: vi.fn(() =>
      Effect.succeed(processes.map((item) => ({ ...item }))),
    ),
    arguments: vi.fn(() => Effect.succeed(new Map())),
    capture: vi.fn(() => Effect.succeed("› prompt\n? for shortcuts")),
    now: () => now,
  };
  const service = makeAgentService(ports);
  const sessions = new Set(initialPanes.map((item) => item.session));
  return {
    ports,
    service,
    sessions,
    setPanes: (value: AgentPaneMetadata[]) => {
      panes = value;
    },
    setProcesses: (value: ForegroundProcess[]) => {
      processes = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("tmux agent observation metadata", () => {
  test("parses core fields without requiring progress and preserves linked memberships", () => {
    const rows = [
      "/socket\t123\t42\ta\t%1\t/dev/pts/1\t10\tcodex\t80\t24\t0\t\ttitle",
      "/socket\t123\t42\tb\t%1\t/dev/pts/1\t10\tcodex\t80\t24\t0\thidden\ttitle",
    ];
    const result = parseAgentPaneMetadata(rows.join("\n"));
    expect(result).toHaveLength(2);
    expect(result[0]?.progress).toBeUndefined();
    expect(result[1]?.progress).toBe("hidden");
    expect(result[0]?.server).toBe(["/socket", "123", "42"].join("\0"));
  });
});

describe("agent observations", () => {
  test("captures only recognized agents in requested sessions and deduplicates linked panes", async () => {
    const f = fixture([
      pane(),
      pane("%1", "linked"),
      { ...pane("%2"), command: "fish" },
      pane("%3", "unregistered"),
    ]);
    const result = await runBunPromise(
      f.service.observe(new Set(["workspace", "linked"]), emptyAgentSnapshot()),
    );
    expect(f.ports.capture).toHaveBeenCalledTimes(1);
    expect(result.observations.get("%1")?.state).toBe("working");
    expect(result.memberships.get("linked")).toEqual(new Set(["%1"]));
    expect(result.observations.has("%2")).toBe(false);
    expect(result.observations.has("%3")).toBe(false);
  });
  test("capture failure affects only one pane and expires its retained state", async () => {
    const f = fixture([pane(), pane("%2")]);
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    f.ports.capture = vi.fn((id) =>
      id === "%1"
        ? Effect.fail(new ProcessOutputLimitError())
        : Effect.succeed("screen"),
    );
    f.setNow(1000);
    const failed = await runBunPromise(f.service.observe(f.sessions, first));
    expect(failed.observations.get("%1")?.reason).toBe("capture_output_limit");
    expect(failed.observations.get("%1")?.freshness).toBe("stale");
    expect(failed.observations.get("%2")?.freshness).toBe("fresh");
    f.setNow(5000);
    const expired = await runBunPromise(f.service.observe(f.sessions, failed));
    expect(expired.observations.get("%1")?.state).toBe("unknown");
    expect(expired.observations.get("%1")?.lastValid?.at).toBe(0);
  });
  test("successful empty screens are unknown, not unavailable", async () => {
    const f = fixture([{ ...pane(), title: "project" }]);
    f.ports.capture = () => Effect.succeed("");
    const result = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    expect(result.observations.get("%1")?.state).toBe("unknown");
    expect(result.observations.get("%1")?.freshness).toBe("fresh");
  });
  test("tmux identity works with a versioned native executable basename", async () => {
    const item = { ...pane(), command: "claude" };
    const f = fixture([item]);
    f.setProcesses([
      {
        ...processFor(item),
        pid: 100,
        command: "/native/claude/versions/2.1.293",
      },
    ]);
    const result = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    expect(result.observations.get("%1")?.agent).toBe("claude");
  });
  test.each(["codex", "claude"])(
    "tmux %s identity never resolves independent competing foreground agents",
    async (command) => {
      const item = { ...pane(), command };
      const leader = { ...processFor(item), pid: 100, command: "codex" };
      const competitor = { ...leader, pid: 101, command };
      const f = fixture([item]);
      f.setProcesses([leader, competitor]);
      const result = await runBunPromise(
        f.service.observe(f.sessions, emptyAgentSnapshot()),
      );
      expect(result.observations.size).toBe(0);
      expect(f.ports.capture).not.toHaveBeenCalled();
    },
  );
  test("a competing foreground agent appearing during capture clears the prior observation", async () => {
    const f = fixture();
    const leader = { ...processFor(pane()), pid: 100 };
    f.setProcesses([leader]);
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    expect(first.observations.get("%1")?.state).toBe("working");
    f.ports.capture = () =>
      Effect.sync(() => {
        f.setProcesses([leader, { ...leader, pid: 101, command: "claude" }]);
        return "› prompt\n? for shortcuts";
      });
    const raced = await runBunPromise(f.service.observe(f.sessions, first));
    expect(raced.observations.size).toBe(0);
    const ambiguous = await runBunPromise(f.service.observe(f.sessions, first));
    expect(ambiguous.observations.size).toBe(0);
  });
  test("tmux native fallback cannot override a verified unrelated runtime entrypoint", async () => {
    const f = fixture();
    f.setProcesses([{ ...processFor(pane()), pid: 100, command: "node" }]);
    f.ports.arguments = () =>
      Effect.succeed(new Map([[100, ["node", "/project/server.js"]]]));
    const result = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    expect(result.observations.size).toBe(0);
    expect(f.ports.capture).not.toHaveBeenCalled();
  });
  test("discovery failure retains memberships, confirmed removal clears them", async () => {
    const f = fixture();
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    const discover = f.ports.discover;
    f.ports.discover = () => Effect.fail(new Error("unavailable"));
    f.setNow(1000);
    const failed = await runBunPromise(f.service.observe(f.sessions, first));
    expect(failed.memberships).toEqual(first.memberships);
    expect(failed.observations.get("%1")?.freshness).toBe("stale");
    f.ports.discover = discover;
    f.setPanes([]);
    const removed = await runBunPromise(f.service.observe(f.sessions, failed));
    expect(removed.observations.size).toBe(0);
    expect(removed.memberships.size).toBe(0);
  });
  test("foreground shell return and suspension invalidate agent state", async () => {
    const f = fixture();
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    f.setProcesses([{ ...processFor(pane()), stat: "T" }]);
    expect(
      (await runBunPromise(f.service.observe(f.sessions, first))).observations
        .size,
    ).toBe(0);
    f.setPanes([{ ...pane(), command: "fish" }]);
    f.setProcesses([{ ...processFor(pane()), command: "fish" }]);
    expect(
      (await runBunPromise(f.service.observe(f.sessions, first))).observations
        .size,
    ).toBe(0);
  });
  test("process/server replacements cannot inherit an earlier classification", async () => {
    const f = fixture();
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    f.setPanes([{ ...pane(), server: "new-server", title: "project" }]);
    f.setProcesses([{ ...processFor(pane()), started: "new-process" }]);
    f.ports.capture = () => Effect.succeed("");
    const next = await runBunPromise(f.service.observe(f.sessions, first));
    expect(next.observations.get("%1")?.generation).not.toBe(
      first.observations.get("%1")?.generation,
    );
    expect(next.observations.get("%1")?.lastValid).toBeUndefined();
  });
  test("late captures from a replaced process are discarded", async () => {
    const f = fixture();
    f.ports.capture = () =>
      Effect.sync(() => {
        f.setProcesses([{ ...processFor(pane()), started: "replacement" }]);
        return "old screen";
      });
    const result = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    expect(result.observations.size).toBe(0);
  });
  test.each(
    ["removed", "dead", "server", "initialPid", "command", "tty"].flatMap(
      (change) => ["working", "blocked"].map((state) => ({ change, state })),
    ),
  )(
    "confirmed $change pane clears $state state despite a failed process recheck",
    async ({ change, state }) => {
      const item = {
        ...pane(),
        title: state === "blocked" ? "Action Required" : "⠋ busy",
      };
      const other = pane("%2");
      const f = fixture([item, other]);
      const screen =
        state === "blocked"
          ? "› prompt\nPress enter to confirm or esc to cancel"
          : "› prompt\n? for shortcuts";
      f.ports.capture = () => Effect.succeed(screen);
      const first = await runBunPromise(
        f.service.observe(f.sessions, emptyAgentSnapshot()),
      );
      expect(first.observations.get("%1")?.state).toBe(state);
      const replacement = {
        ...item,
        dead: change === "dead",
        server: change === "server" ? "replacement-server" : item.server,
        initialPid: change === "initialPid" ? 99 : item.initialPid,
        command: change === "command" ? "fish" : item.command,
        tty: change === "tty" ? "/dev/pts/99" : item.tty,
      };
      f.setNow(1000);
      f.ports.capture = (id) =>
        Effect.sync(() => {
          if (id === "%1") {
            f.setPanes(change === "removed" ? [other] : [replacement, other]);
            f.ports.processes = () =>
              Effect.fail(new Error("processes unavailable"));
          }
          return screen;
        });
      const result = await runBunPromise(f.service.observe(f.sessions, first));
      expect(result.observations.has("%1")).toBe(false);
      expect(result.observations.size).toBe(1);
      expect(result.observations.get("%2")).toMatchObject({
        state: "working",
        freshness: "stale",
        reason: "validation_unavailable",
        lastValid: { at: 0 },
      });
    },
  );
  test("tmux invalidation also clears wrapper state retained before another pane's capture", async () => {
    const item = { ...pane(), command: "node" };
    const other = pane("%2");
    const f = fixture([item, other]);
    f.setProcesses([
      { ...processFor(item), pid: 100 },
      { ...processFor(other), pgid: 102, tpgid: 102 },
    ]);
    f.ports.arguments = () =>
      Effect.succeed(
        new Map([
          [100, ["node", "/pkg/node_modules/@openai/codex/bin/codex.js"]],
        ]),
      );
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    expect(first.observations.size).toBe(2);
    f.setNow(1000);
    f.ports.arguments = () => Effect.fail(new Error("arguments unavailable"));
    f.ports.capture = () =>
      Effect.sync(() => {
        f.setPanes([other]);
        f.ports.processes = () =>
          Effect.fail(new Error("processes unavailable"));
        return "› prompt\n? for shortcuts";
      });
    const result = await runBunPromise(f.service.observe(f.sessions, first));
    expect(result.observations.has("%1")).toBe(false);
    expect(result.observations.get("%2")?.freshness).toBe("stale");
  });
  test.each([
    "exit",
    "suspension",
    "background",
    "restart",
    "entrypoint",
    "agent",
    "ambiguous",
    "unchanged",
    "missing arguments",
    "exit with missing arguments",
    "exit with failed discovery",
  ])(
    "retained wrapper state is revalidated after another pane's capture: %s",
    async (change) => {
      const item = { ...pane(), command: "node" };
      const other = pane("%2");
      const wrapper = { ...processFor(item), pid: 100 };
      const native = { ...wrapper, pid: 101, ppid: 100, command: "codex" };
      const otherProcess = { ...processFor(other), pgid: 102, tpgid: 102 };
      const f = fixture([item, other]);
      f.setProcesses([wrapper, native, otherProcess]);
      const args = new Map([
        [100, ["node", "/pkg/node_modules/@openai/codex/bin/codex.js"]],
      ]);
      f.ports.arguments = () => Effect.succeed(args);
      const first = await runBunPromise(
        f.service.observe(f.sessions, emptyAgentSnapshot()),
      );
      const prior = first.observations.get("%1");
      expect(prior?.state).toBe("working");
      let initialArguments = true;
      f.ports.arguments = () => {
        if (initialArguments || change.includes("missing arguments")) {
          initialArguments = false;
          return Effect.fail(new Error("arguments unavailable"));
        }
        return Effect.succeed(args);
      };
      f.setNow(1000);
      f.ports.capture = vi.fn(() =>
        Effect.sync(() => {
          if (change.startsWith("exit")) f.setProcesses([otherProcess]);
          if (change === "suspension")
            f.setProcesses([
              { ...wrapper, stat: "T" },
              { ...native, stat: "T" },
              otherProcess,
            ]);
          if (change === "background")
            f.setProcesses([
              { ...wrapper, tpgid: 900 },
              { ...native, tpgid: 900 },
              otherProcess,
            ]);
          if (change === "restart")
            f.setProcesses([
              { ...wrapper, started: "replacement" },
              native,
              otherProcess,
            ]);
          if (change === "entrypoint")
            args.set(100, ["node", "/project/server.js"]);
          if (change === "agent")
            args.set(100, [
              "node",
              "/pkg/node_modules/@anthropic-ai/claude-code/cli.js",
            ]);
          if (change === "ambiguous")
            f.setProcesses([
              wrapper,
              native,
              otherProcess,
              { ...wrapper, pid: 103, ppid: 10, command: "claude" },
            ]);
          if (change === "exit with failed discovery")
            f.ports.discover = () =>
              Effect.fail(new Error("discovery unavailable"));
          return "› prompt\n? for shortcuts";
        }),
      );
      const result = await runBunPromise(f.service.observe(f.sessions, first));
      expect(f.ports.capture).toHaveBeenCalledExactlyOnceWith("%2");
      if (change === "unchanged" || change === "missing arguments") {
        expect(result.observations.get("%1")).toMatchObject({
          generation: prior?.generation,
          state: "working",
          freshness: "stale",
          reason: "arguments_unavailable",
          lastValid: { at: 0 },
        });
      } else expect(result.observations.has("%1")).toBe(false);
      expect(result.observations.get("%2")?.state).toBe("working");
    },
  );
  test("retained wrapper observations are rechecked even when every pane skips capture", async () => {
    const item = { ...pane(), command: "node" };
    const wrapper = { ...processFor(item), pid: 100 };
    const native = { ...wrapper, pid: 101, ppid: 100, command: "codex" };
    const f = fixture([item]);
    f.setProcesses([wrapper, native]);
    f.ports.arguments = () =>
      Effect.succeed(
        new Map([
          [100, ["node", "/pkg/node_modules/@openai/codex/bin/codex.js"]],
        ]),
      );
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    let initialArguments = true;
    f.ports.arguments = () => {
      if (initialArguments) {
        initialArguments = false;
        return Effect.fail(new Error("arguments unavailable"));
      }
      return Effect.succeed(new Map([[100, ["node", "/project/server.js"]]]));
    };
    f.setNow(1000);
    f.ports.capture = vi.fn(() => Effect.succeed("› prompt\n? for shortcuts"));
    const result = await runBunPromise(f.service.observe(f.sessions, first));
    expect(f.ports.capture).not.toHaveBeenCalled();
    expect(result.observations.size).toBe(0);
  });
  test("a relaunch cannot classify residual screen/title evidence from the old generation", async () => {
    const f = fixture();
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    f.setProcesses([{ ...processFor(pane()), started: "replacement" }]);
    const restarted = await runBunPromise(f.service.observe(f.sessions, first));
    expect(restarted.observations.get("%1")?.state).toBe("unknown");
    expect(restarted.observations.get("%1")?.reason).toBe("generation_changed");
    expect(restarted.observations.get("%1")?.lastValid).toBeUndefined();
    f.ports.capture = () =>
      Effect.succeed("› prompt\nPress enter to confirm or esc to cancel");
    const changed = await runBunPromise(
      f.service.observe(f.sessions, restarted),
    );
    // The unchanged old busy title must not outrank the new live controls.
    expect(changed.observations.get("%1")?.state).toBe("blocked");
  });
  test("title or resize races become unavailable rather than publishing incoherent state", async () => {
    const f = fixture();
    f.ports.capture = () =>
      Effect.sync(() => {
        f.setPanes([{ ...pane(), title: "changed", width: 40 }]);
        return "old screen";
      });
    const result = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    expect(result.observations.get("%1")?.state).toBe("unknown");
    expect(result.observations.get("%1")?.reason).toBe("sample_changed");
  });
  test("failed process inspection cannot claim a live state and keeps a bounded last observation", async () => {
    const f = fixture();
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    f.ports.processes = () => Effect.fail(new Error("permission denied"));
    f.setNow(1000);
    const failed = await runBunPromise(f.service.observe(f.sessions, first));
    expect(failed.observations.get("%1")?.reason).toBe(
      "process_inspection_unavailable",
    );
    expect(failed.observations.get("%1")?.freshness).toBe("stale");
    expect(failed.observations.get("%1")?.lastValid?.at).toBe(0);
  });
  test("runtime argv is cached only while the foreground process generation survives", async () => {
    const f = fixture([{ ...pane(), command: "node" }]);
    f.ports.arguments = vi.fn(() =>
      Effect.succeed(
        new Map([
          [101, ["node", "/pkg/node_modules/@openai/codex/bin/codex.js"]],
        ]),
      ),
    );
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    expect(first.observations.get("%1")?.agent).toBe("codex");
    await runBunPromise(f.service.observe(f.sessions, first));
    expect(vi.mocked(f.ports.arguments).mock.calls[2]?.[0]).toHaveLength(0);
    f.setProcesses([
      { ...processFor({ ...pane(), command: "node" }), started: "replacement" },
    ]);
    f.ports.arguments = vi.fn(() => Effect.succeed(new Map()));
    const replacement = await runBunPromise(
      f.service.observe(f.sessions, first),
    );
    expect(replacement.observations.size).toBe(0);
  });
  test.each([
    ["node", "before", "failure"],
    ["node", "after", "failure"],
    ["codex", "before", "failure"],
    ["codex", "after", "failure"],
    ["node", "before", "missing"],
    ["node", "after", "missing"],
    ["node", "before", "empty"],
    ["node", "after", "empty"],
  ])(
    "%s wrapper arguments %s capture becoming %s retain bounded prior state and recover",
    async (command, phase, failure) => {
      const item = { ...pane(), command };
      const wrapper = { ...processFor(item), pid: 100, command: "node" };
      const native = { ...wrapper, pid: 101, ppid: 100, command: "codex" };
      const f = fixture([item]);
      f.setProcesses([wrapper, native]);
      const args = new Map([
        [100, ["node", "/pkg/node_modules/@openai/codex/bin/codex.js"]],
      ]);
      f.ports.arguments = () => Effect.succeed(args);
      const first = await runBunPromise(
        f.service.observe(f.sessions, emptyAgentSnapshot()),
      );
      const prior = first.observations.get("%1");
      expect(prior?.generation).toContain(":100:start:100");
      expect(prior?.state).toBe("working");
      let calls = 0;
      f.ports.arguments = () => {
        if (phase === "after" && calls++ % 2 === 0) return Effect.succeed(args);
        return failure === "failure"
          ? Effect.fail(new Error("arguments unavailable"))
          : Effect.succeed(
              failure === "empty" ? new Map([[100, []]]) : new Map(),
            );
      };
      f.setNow(1000);
      const failed = await runBunPromise(f.service.observe(f.sessions, first));
      expect(failed.observations.get("%1")).toMatchObject({
        agent: "codex",
        generation: prior?.generation,
        state: "working",
        freshness: "stale",
        reason: "arguments_unavailable",
        lastValid: { at: 0 },
      });
      f.setNow(5000);
      const expired = await runBunPromise(
        f.service.observe(f.sessions, failed),
      );
      expect(expired.observations.get("%1")).toMatchObject({
        generation: prior?.generation,
        state: "unknown",
        freshness: "unavailable",
        lastValid: { at: 0 },
      });
      f.ports.arguments = () => Effect.succeed(args);
      f.setNow(6000);
      const recovered = await runBunPromise(
        f.service.observe(f.sessions, expired),
      );
      expect(recovered.observations.get("%1")).toMatchObject({
        generation: prior?.generation,
        state: "working",
        freshness: "fresh",
        lastValid: { at: 6000 },
      });
    },
  );
  test("verified wrapper entrypoint replacement during capture still discards the observation", async () => {
    const item = { ...pane(), command: "node" };
    const wrapper = { ...processFor(item), pid: 100 };
    const native = { ...wrapper, pid: 101, ppid: 100, command: "codex" };
    const f = fixture([item]);
    f.setProcesses([wrapper, native]);
    const args = new Map([
      [100, ["node", "/pkg/node_modules/@openai/codex/bin/codex.js"]],
    ]);
    f.ports.arguments = () => Effect.succeed(args);
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    f.ports.capture = () =>
      Effect.sync(() => {
        args.set(100, ["node", "/project/server.js"]);
        return "› prompt\n? for shortcuts";
      });
    const replaced = await runBunPromise(f.service.observe(f.sessions, first));
    expect(replaced.observations.size).toBe(0);
  });
  test("argument failure cannot retain a wrapper whose process changed during capture", async () => {
    const item = { ...pane(), command: "node" };
    const wrapper = { ...processFor(item), pid: 100 };
    const native = { ...wrapper, pid: 101, ppid: 100, command: "codex" };
    const f = fixture([item]);
    f.setProcesses([wrapper, native]);
    f.ports.arguments = () =>
      Effect.succeed(
        new Map([
          [100, ["node", "/pkg/node_modules/@openai/codex/bin/codex.js"]],
        ]),
      );
    const first = await runBunPromise(
      f.service.observe(f.sessions, emptyAgentSnapshot()),
    );
    f.ports.capture = () =>
      Effect.sync(() => {
        f.setProcesses([{ ...wrapper, started: "replacement" }, native]);
        f.ports.arguments = () =>
          Effect.fail(new Error("arguments unavailable"));
        return "› prompt\n? for shortcuts";
      });
    const replaced = await runBunPromise(f.service.observe(f.sessions, first));
    expect(replaced.observations.size).toBe(0);
  });
  test("bounds capture concurrency and interrupts pending observations", async () => {
    const f = fixture(Array.from({ length: 15 }, (_, i) => pane(`%${i + 1}`)));
    let active = 0;
    let maximum = 0;
    f.ports.capture = () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active++;
          maximum = Math.max(maximum, active);
        }),
        () => Effect.never,
        () =>
          Effect.sync(() => {
            active--;
          }),
      );
    const controller = new AbortController();
    const result = Effect.runPromise(
      provideBunServices(f.service.observe(f.sessions, emptyAgentSnapshot())),
      { signal: controller.signal },
    );
    const rejection = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(active).toBe(4));
    controller.abort();
    await rejection;
    expect(maximum).toBe(4);
    expect(active).toBe(0);
  });
  test("timeout and output limits have structured reasons without raw output", () => {
    expect(observationFailureReason({ _tag: "TimeoutError" })).toBe("timeout");
    expect(observationFailureReason(new ProcessOutputLimitError())).toBe(
      "output_limit",
    );
  });
});

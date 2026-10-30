import { PassThrough } from "node:stream";
import React, { type FC } from "react";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import type { TmuxClient, TmuxPaneInfo } from "../../src/services/tmux";

const tmuxServiceMock = vi.hoisted(() => ({
  listClients: vi.fn(),
  listSessions: vi.fn(),
  listPanes: vi.fn(),
  switchClientToPane: vi.fn(),
  detachClient: vi.fn(),
  togglePaneZoom: vi.fn(),
  killPane: vi.fn(),
}));

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn(),
  },
}));

vi.mock("../../src/services/tmux", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/services/tmux")
  >("../../src/services/tmux");

  return {
    ...actual,
    TmuxService: {
      use: (selector: (service: typeof tmuxServiceMock) => unknown) =>
        selector({
          ...tmuxServiceMock,
          get listClients() {
            return tmuxServiceMock.listClients();
          },
          get listSessions() {
            return tmuxServiceMock.listSessions();
          },
        }),
    },
  };
});

// Import after registering mocks so the hook captures the mocked runtime.
const { tuiRuntime } = await import("../../src/tui/runtime");
const { useTmux } = await import("../../src/tui/hooks/useTmux");

const mockRunPromise = tuiRuntime.runPromise as Mock;
type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};
type TmuxHookValue = ReturnType<typeof useTmux>;

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 80;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

async function renderUseTmux() {
  let latest: TmuxHookValue | undefined;
  const Wrapper: FC = () => {
    latest = useTmux();
    return null;
  };
  const { stdout, stdin } = createStdoutStdin();
  const { render } = await import("ink");
  const instance = render(React.createElement(Wrapper), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    get value() {
      if (!latest) throw new Error("Hook not captured");
      return latest;
    },
    unmount() {
      instance.unmount();
    },
  };
}

async function flush(n = 5) {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function renderWithSingleClient() {
  const singleClient = { tty: "/dev/ttys001", session: "main" };
  mockRunPromise
    .mockResolvedValueOnce([singleClient]) // listClients
    .mockResolvedValueOnce(null); // listSessions

  const harness = await renderUseTmux();
  await flush(10);

  expect(harness.value.client).toEqual(singleClient);
  return harness;
}

describe("useTmux hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunPromise.mockReset();
  });

  test("reports an error when no tmux client is found", async () => {
    mockRunPromise
      .mockResolvedValueOnce([]) // listClients
      .mockResolvedValueOnce(null); // listSessions

    const harness = await renderUseTmux();
    await flush(10);

    expect(harness.value.client).toBeNull();
    expect(harness.value.error).toBe(
      "No tmux client found \u2014 start tmux in the other pane",
    );

    harness.unmount();
  });

  test("stores the single client when exactly one tmux client is found", async () => {
    const singleClient = { tty: "/dev/ttys001", session: "main" };

    mockRunPromise
      .mockResolvedValueOnce([singleClient]) // listClients
      .mockResolvedValueOnce(null); // listSessions

    const harness = await renderUseTmux();
    await flush(10);

    expect(harness.value.client).toEqual(singleClient);
    expect(harness.value.error).toBeNull();

    harness.unmount();
  });

  test("leaves client selection unresolved when multiple clients exist", async () => {
    const clientA = { tty: "/dev/ttys001", session: "a" };
    const clientB = { tty: "/dev/ttys002", session: "b" };

    mockRunPromise
      .mockResolvedValueOnce([clientA, clientB]) // listClients
      .mockResolvedValueOnce(null); // listSessions

    const harness = await renderUseTmux();
    await flush(10);

    expect(harness.value.client).toBeNull();
    expect(harness.value.error).toBeNull();

    harness.unmount();
  });

  test("discoverClient returns multiple when client ownership is ambiguous", async () => {
    const harness = await renderWithSingleClient();

    mockRunPromise.mockResolvedValueOnce([
      { tty: "/dev/ttys001", session: "main" },
      { tty: "/dev/ttys002", session: "feature-a" },
    ]);

    const result = await harness.value.discoverClient();
    await flush(2);

    expect(result).toEqual({ type: "multiple" });
    expect(harness.value.client).toBeNull();
    expect(harness.value.error).toBeNull();

    harness.unmount();
  });

  test("refreshSessions returns the latest parsed tmux sessions", async () => {
    const harness = await renderWithSingleClient();

    mockRunPromise
      .mockResolvedValueOnce([
        { name: "main", attached: true },
        { name: "feature-a", attached: false },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await harness.value.refreshSessions();
    await flush(2);

    expect(result).toEqual([
      { name: "main", attached: true },
      { name: "feature-a", attached: false },
    ]);
    expect(harness.value.sessions).toEqual(result);

    harness.unmount();
  });

  test.each(["success", "empty", "failure"])(
    "ignores an older session %s after a newer observation",
    async (outcome) => {
      const harness = await renderWithSingleClient();
      const pending = Promise.withResolvers<
        { name: string; attached: boolean }[] | null
      >();
      try {
        const freshSessions = [{ name: "new", attached: true }];
        mockRunPromise
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValueOnce(freshSessions)
          .mockResolvedValueOnce([])
          .mockResolvedValue([]);
        const older = harness.value.refreshSessions();
        expect(await harness.value.refreshSessions()).toEqual(freshSessions);
        if (outcome === "failure") pending.reject(new Error("old failure"));
        else
          pending.resolve(
            outcome === "empty" ? null : [{ name: "old", attached: false }],
          );
        await older;
        await flush();
        expect(harness.value.sessions).toEqual(freshSessions);
        expect([...harness.value.panes.keys()]).toEqual(["new"]);
      } finally {
        pending.resolve(null);
        harness.unmount();
      }
    },
  );

  test("does not restore delayed panes after a newer empty session observation", async () => {
    const harness = await renderWithSingleClient();
    const pending = Promise.withResolvers<TmuxPaneInfo[]>();
    const started = Promise.withResolvers<void>();
    try {
      mockRunPromise
        .mockResolvedValueOnce([{ name: "old", attached: false }])
        .mockImplementationOnce(() => {
          started.resolve();
          return pending.promise;
        });
      const older = harness.value.refreshSessions();
      await started.promise;
      mockRunPromise.mockResolvedValueOnce(null);
      expect(await harness.value.refreshSessions()).toEqual([]);
      pending.resolve([]);
      expect(await older).toEqual([{ name: "old", attached: false }]);
      await flush();
      expect(harness.value.sessions).toEqual([]);
      expect(harness.value.panes.size).toBe(0);
    } finally {
      pending.resolve([]);
      harness.unmount();
    }
  });

  test("publishes sessions and clients while newer observations remain pending", async () => {
    const harness = await renderWithSingleClient();
    const firstSessions =
      Promise.withResolvers<{ name: string; attached: boolean }[]>();
    const secondSessions =
      Promise.withResolvers<{ name: string; attached: boolean }[]>();
    const firstClients = Promise.withResolvers<TmuxClient[]>();
    const secondClients = Promise.withResolvers<TmuxClient[]>();
    const running: Promise<unknown>[] = [];
    try {
      mockRunPromise
        .mockReturnValueOnce(firstSessions.promise)
        .mockReturnValueOnce(firstClients.promise)
        .mockReturnValueOnce(secondSessions.promise)
        .mockReturnValueOnce(secondClients.promise)
        .mockResolvedValue([]);
      const sessionsA = harness.value.refreshSessions();
      const clientA = harness.value.discoverClient();
      const sessionsB = harness.value.refreshSessions();
      const clientB = harness.value.discoverClient();
      running.push(sessionsA, clientA, sessionsB, clientB);
      const observedSessions = [{ name: "first", attached: true }];
      const observedClient = { tty: "/dev/ttys002", session: "first" };
      firstSessions.resolve(observedSessions);
      firstClients.resolve([observedClient]);
      await Promise.all([sessionsA, clientA]);
      await flush();
      expect(harness.value.sessions).toEqual(observedSessions);
      expect([...harness.value.panes.keys()]).toEqual(["first"]);
      expect(harness.value.client).toEqual(observedClient);

      secondSessions.resolve([]);
      secondClients.resolve([]);
      await Promise.all([sessionsB, clientB]);
      await flush();
      expect(harness.value.sessions).toEqual([]);
      expect(harness.value.panes.size).toBe(0);
      expect(harness.value.client).toBeNull();
    } finally {
      firstSessions.resolve([]);
      secondSessions.resolve([]);
      firstClients.resolve([]);
      secondClients.resolve([]);
      await Promise.all(running);
      harness.unmount();
    }
  });

  test.each(["success", "empty", "failure", "multiple"])(
    "ignores an older client %s after a newer discovery",
    async (outcome) => {
      const harness = await renderWithSingleClient();
      const pending = Promise.withResolvers<TmuxClient[]>();
      const fresh = { tty: "/dev/ttys002", session: "new" };
      try {
        mockRunPromise
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValueOnce([fresh]);
        const older = harness.value.discoverClient();
        expect(await harness.value.discoverClient()).toEqual({
          type: "single",
          client: fresh,
        });
        if (outcome === "failure") pending.reject(new Error("old failure"));
        else
          pending.resolve(
            outcome === "empty"
              ? []
              : outcome === "multiple"
                ? [fresh, { tty: "/dev/ttys001", session: "old" }]
                : [{ tty: "/dev/ttys001", session: "old" }],
          );
        await older;
        await flush();
        expect(harness.value.client).toEqual(fresh);
        expect(harness.value.error).toBeNull();
      } finally {
        pending.resolve([]);
        harness.unmount();
      }
    },
  );

  test.each([
    { action: "switch", timing: "before" },
    { action: "detach", timing: "before" },
    { action: "switch", timing: "during" },
    { action: "detach", timing: "during" },
  ])(
    "invalidates discoveries started $timing a successful client $action",
    async ({ action, timing }) => {
      const harness = await renderWithSingleClient();
      const pending = Promise.withResolvers<TmuxClient[]>();
      const actionPending = Promise.withResolvers<void>();
      try {
        const runAction = () =>
          action === "switch"
            ? harness.value.switchSession("new")
            : harness.value.detachClient();
        mockRunPromise
          .mockReturnValueOnce(
            timing === "before" ? pending.promise : actionPending.promise,
          )
          .mockReturnValueOnce(
            timing === "before" ? actionPending.promise : pending.promise,
          );
        const first =
          timing === "before" ? harness.value.discoverClient() : runAction();
        const second =
          timing === "before" ? runAction() : harness.value.discoverClient();
        actionPending.resolve();
        expect(await (timing === "before" ? second : first)).toBe(true);
        pending.resolve([{ tty: "/dev/ttys001", session: "main" }]);
        await (timing === "before" ? first : second);
        await flush();
        expect(harness.value.client).toEqual(
          action === "switch" ? { tty: "/dev/ttys001", session: "new" } : null,
        );
      } finally {
        actionPending.resolve();
        pending.resolve([]);
        harness.unmount();
      }
    },
  );

  test("preserves the current snapshot when aborted pane reads fail", async () => {
    const harness = await renderWithSingleClient();
    const pending = Promise.withResolvers<TmuxPaneInfo[]>();
    const started = Promise.withResolvers<void>();
    const controller = new AbortController();
    try {
      const stable = [{ name: "stable", attached: true }];
      mockRunPromise.mockResolvedValueOnce(stable).mockResolvedValueOnce([]);
      await harness.value.refreshSessions();
      mockRunPromise
        .mockResolvedValueOnce([{ name: "cancelled", attached: false }])
        .mockImplementationOnce(() => {
          started.resolve();
          return pending.promise;
        });
      const refreshing = harness.value.refreshSessions(controller.signal);
      await started.promise;
      controller.abort();
      pending.reject(new Error("cancelled pane read"));
      expect(await refreshing).toEqual([]);
      await flush();
      expect(harness.value.sessions).toEqual(stable);
      expect([...harness.value.panes.keys()]).toEqual(["stable"]);
    } finally {
      pending.resolve([]);
      harness.unmount();
    }
  });

  test.each(["abort", "unmount"])(
    "discards direct session and client refreshes after %s",
    async (cancellation) => {
      const harness = await renderWithSingleClient();
      const pendingSessions =
        Promise.withResolvers<{ name: string; attached: boolean }[]>();
      const pendingClients = Promise.withResolvers<TmuxClient[]>();
      const controller = new AbortController();
      try {
        mockRunPromise
          .mockReturnValueOnce(pendingSessions.promise)
          .mockReturnValueOnce(pendingClients.promise);
        const signal = cancellation === "abort" ? controller.signal : undefined;
        const sessions = harness.value.refreshSessions(signal);
        const clients = harness.value.discoverClient(signal);
        if (cancellation === "abort") controller.abort();
        else harness.unmount();
        pendingSessions.resolve([{ name: "cancelled", attached: true }]);
        pendingClients.resolve([]);
        expect(await sessions).toEqual([]);
        expect(await clients).toEqual({ type: "error" });
        await flush();
        expect(harness.value.sessions).toEqual([]);
        expect(harness.value.client).toEqual({
          tty: "/dev/ttys001",
          session: "main",
        });
        expect(harness.value.error).toBeNull();
      } finally {
        pendingSessions.resolve([]);
        pendingClients.resolve([]);
        if (cancellation !== "unmount") harness.unmount();
      }
    },
  );

  test("switchSession returns false when no active client exists", async () => {
    mockRunPromise
      .mockResolvedValueOnce([]) // listClients
      .mockResolvedValueOnce(null); // listSessions

    const harness = await renderUseTmux();
    await flush(10);

    expect(harness.value.client).toBeNull();

    const result = await harness.value.switchSession("foo");
    expect(result).toBe(false);

    harness.unmount();
  });

  test("switchSession updates the tracked client session after success", async () => {
    const harness = await renderWithSingleClient();

    mockRunPromise.mockResolvedValueOnce(undefined);

    const result = await harness.value.switchSession("feature-a");
    await flush(2);

    expect(result).toBe(true);
    expect(harness.value.client).toEqual({
      tty: "/dev/ttys001",
      session: "feature-a",
    });

    harness.unmount();
  });

  test("switchSession can use an explicitly discovered client snapshot", async () => {
    mockRunPromise
      .mockResolvedValueOnce([]) // listClients
      .mockResolvedValueOnce(null); // listSessions

    const harness = await renderUseTmux();
    await flush(10);

    const result = await harness.value.switchSession("feature-a", {
      tty: "/dev/ttys001",
      session: "main",
    });
    await flush(2);

    expect(result).toBe(true);
    expect(harness.value.client).toEqual({
      tty: "/dev/ttys001",
      session: "feature-a",
    });

    harness.unmount();
  });

  test("jumpToPane refreshes the tracked client session after success", async () => {
    const harness = await renderWithSingleClient();

    mockRunPromise
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ tty: "/dev/ttys001", session: "feature-a" }]);

    const result = await harness.value.jumpToPane("%42");
    await flush(2);

    expect(result).toBe(true);
    expect(harness.value.client).toEqual({
      tty: "/dev/ttys001",
      session: "feature-a",
    });

    harness.unmount();
  });

  test("jumpToPane returns false when runtime navigation fails", async () => {
    const harness = await renderWithSingleClient();

    mockRunPromise.mockRejectedValueOnce(new Error("tmux switch failed"));

    const result = await harness.value.jumpToPane("pane-id");
    expect(result).toBe(false);

    harness.unmount();
  });

  test("zoomPane still runs when no active client exists", async () => {
    mockRunPromise
      .mockResolvedValueOnce([]) // listClients
      .mockResolvedValueOnce(null) // listSessions
      .mockResolvedValueOnce(undefined); // togglePaneZoom

    const harness = await renderUseTmux();
    await flush(10);

    expect(harness.value.client).toBeNull();

    const result = await harness.value.zoomPane("pane-id");
    expect(result).toBe(true);
    expect(tmuxServiceMock.togglePaneZoom).toHaveBeenCalledWith("pane-id");

    harness.unmount();
  });

  test("zoomPane returns true when the runtime call succeeds", async () => {
    const harness = await renderWithSingleClient();

    mockRunPromise.mockResolvedValueOnce(undefined);

    const result = await harness.value.zoomPane("pane-id");
    expect(result).toBe(true);
    expect(tmuxServiceMock.togglePaneZoom).toHaveBeenCalledWith("pane-id");

    harness.unmount();
  });

  test("zoomPane returns false when the runtime call rejects", async () => {
    const harness = await renderWithSingleClient();

    mockRunPromise.mockRejectedValueOnce(new Error("tmux zoom failed"));

    const result = await harness.value.zoomPane("pane-id");
    expect(result).toBe(false);
    expect(tmuxServiceMock.togglePaneZoom).toHaveBeenCalledWith("pane-id");

    harness.unmount();
  });

  test("killPane still runs when no active client exists", async () => {
    mockRunPromise
      .mockResolvedValueOnce([]) // listClients
      .mockResolvedValueOnce(null) // listSessions
      .mockResolvedValueOnce(undefined); // killPane

    const harness = await renderUseTmux();
    await flush(10);

    expect(harness.value.client).toBeNull();

    const result = await harness.value.killPane("pane-id");
    expect(result).toBe(true);
    expect(tmuxServiceMock.killPane).toHaveBeenCalledWith("pane-id");

    harness.unmount();
  });

  test("killPane returns true when the runtime call succeeds", async () => {
    const harness = await renderWithSingleClient();

    mockRunPromise.mockResolvedValueOnce(undefined);

    const result = await harness.value.killPane("pane-id");
    expect(result).toBe(true);
    expect(tmuxServiceMock.killPane).toHaveBeenCalledWith("pane-id");

    harness.unmount();
  });

  test("killPane returns false when the runtime call rejects", async () => {
    const harness = await renderWithSingleClient();

    mockRunPromise.mockRejectedValueOnce(new Error("tmux kill failed"));

    const result = await harness.value.killPane("pane-id");
    expect(result).toBe(false);
    expect(tmuxServiceMock.killPane).toHaveBeenCalledWith("pane-id");

    harness.unmount();
  });
});

import { PassThrough } from "node:stream";
import React, { type FC } from "react";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";

const tmuxServiceMock = vi.hoisted(() => ({
  listClients: vi.fn(),
  listSessions: vi.fn(),
  listPanes: vi.fn(),
  switchClientToPane: vi.fn(),
  togglePaneZoom: vi.fn(),
  killPane: vi.fn(),
  selectPane: vi.fn(),
  refreshClient: vi.fn(),
}));

// Mock tuiRuntime before importing the hook
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
        selector(tmuxServiceMock),
    },
  };
});

// Lazy imports so the mock is in place
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
    // discoverClient: listClients returns []
    // refreshSessions: listSessions returns null
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

    // discoverClient: listClients returns [client]
    // refreshSessions: listSessions returns null
    mockRunPromise
      .mockResolvedValueOnce([singleClient]) // listClients
      .mockResolvedValueOnce(null); // listSessions

    const harness = await renderUseTmux();
    await flush(10);

    expect(harness.value.client).toEqual(singleClient);
    expect(harness.value.error).toBeNull();

    harness.unmount();
  });

  test("reports a multi-client error when more than one client exists", async () => {
    const clientA = { tty: "/dev/ttys001", session: "a" };
    const clientB = { tty: "/dev/ttys002", session: "b" };

    // discoverClient: listClients returns [a, b]
    // refreshSessions: listSessions returns null
    mockRunPromise
      .mockResolvedValueOnce([clientA, clientB]) // listClients
      .mockResolvedValueOnce(null); // listSessions

    const harness = await renderUseTmux();
    await flush(10);

    expect(harness.value.client).toBeNull();
    expect(harness.value.error).toBe(
      "Multiple tmux clients found (2). Multi-client support coming soon.",
    );

    harness.unmount();
  });

  test("switchSession returns false when no active client exists", async () => {
    // Mount with no clients so client stays null
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

  test("jumpToPane returns false when runtime navigation fails", async () => {
    const harness = await renderWithSingleClient();

    // Make the next runPromise call reject (switchClientToPane failure)
    mockRunPromise.mockRejectedValueOnce(new Error("tmux switch failed"));

    const result = await harness.value.jumpToPane("pane-id");
    expect(result).toBe(false);

    harness.unmount();
  });

  test("zoomPane returns false when no active client exists", async () => {
    mockRunPromise
      .mockResolvedValueOnce([]) // listClients
      .mockResolvedValueOnce(null); // listSessions

    const harness = await renderUseTmux();
    await flush(10);

    expect(harness.value.client).toBeNull();

    const result = await harness.value.zoomPane("pane-id");
    expect(result).toBe(false);

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

  test("killPane returns false when no active client exists", async () => {
    mockRunPromise
      .mockResolvedValueOnce([]) // listClients
      .mockResolvedValueOnce(null); // listSessions

    const harness = await renderUseTmux();
    await flush(10);

    expect(harness.value.client).toBeNull();

    const result = await harness.value.killPane("pane-id");
    expect(result).toBe(false);

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

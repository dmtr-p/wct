import { PassThrough } from "node:stream";
import React, { type FC } from "react";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";

// Mock tuiRuntime before importing the hook
vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn(),
  },
}));

// Lazy imports so the mock is in place
const { tuiRuntime } = await import("../../src/tui/runtime");
const { useTmux } = await import("../../src/tui/hooks/useTmux");

const mockRunPromise = tuiRuntime.runPromise as Mock;

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 80;
  (stdout as any).rows = 24;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = false;
  (stdin as any).setRawMode = () => stdin;
  return { stdout, stdin };
}

async function renderUseTmux() {
  let latest: ReturnType<typeof useTmux> | undefined;
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

describe("useTmux hook", () => {
  beforeEach(() => {
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
    const singleClient = { tty: "/dev/ttys001", session: "main" };

    // Mount with one client so client is set
    mockRunPromise
      .mockResolvedValueOnce([singleClient]) // listClients
      .mockResolvedValueOnce(null); // listSessions

    const harness = await renderUseTmux();
    await flush(10);

    expect(harness.value.client).toEqual(singleClient);

    // Make the next runPromise call reject (switchClientToPane failure)
    mockRunPromise.mockRejectedValueOnce(new Error("tmux switch failed"));

    const result = await harness.value.jumpToPane("pane-id");
    expect(result).toBe(false);

    harness.unmount();
  });
});

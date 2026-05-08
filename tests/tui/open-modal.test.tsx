import { PassThrough } from "node:stream";
import type React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const runPromiseMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: runPromiseMock,
  },
}));

vi.mock("../../src/tui/hooks/useBlink", () => ({
  useBlink: () => false,
}));

const { ExistingBranchForm, FromPRForm, NewBranchForm, OpenModal } =
  await import("../../src/tui/components/OpenModal");

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 100;
  stdout.rows = 32;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

function stripAnsi(value: string) {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (char === "\u001B" && value.charAt(i + 1) === "[") {
      i += 2;
      while (i < value.length && !/[\x40-\x7E]/.test(value.charAt(i))) {
        i += 1;
      }
      continue;
    }
    if (char !== "\r") {
      output += char;
    }
  }
  return output;
}

async function renderNode(node: React.ReactElement) {
  const { stdout, stdin } = createStdoutStdin();
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });

  const { render } = await import("ink");
  const instance = render(node, {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    output: stripAnsi(chunks.join("")),
    unmount() {
      instance.unmount();
    },
  };
}

describe("OpenModal form variants", () => {
  afterEach(() => {
    vi.clearAllMocks();
    runPromiseMock.mockReset();
  });

  test("new branch form shows No IDE and Auto-switch toggles", async () => {
    const rendered = await renderNode(
      <NewBranchForm
        defaultBase="main"
        profileNames={["default"]}
        onSubmit={() => {}}
        onBack={() => {}}
        width={80}
      />,
    );

    try {
      expect(rendered.output).toContain("No IDE");
      expect(rendered.output).toContain("Auto-switch");
      expect(rendered.output).not.toContain("No attach");
    } finally {
      rendered.unmount();
    }
  });

  test("from PR form shows No IDE and Auto-switch toggles", async () => {
    const rendered = await renderNode(
      <FromPRForm
        prList={[
          {
            number: 123,
            title: "Feature from PR",
            state: "OPEN",
            headRefName: "feature-from-pr",
            rollupState: null,
          },
        ]}
        profileNames={["backend"]}
        isRefreshing={false}
        onRefresh={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
        width={80}
      />,
    );

    try {
      expect(rendered.output).toContain("No IDE");
      expect(rendered.output).toContain("Auto-switch");
      expect(rendered.output).not.toContain("No attach");
      expect(rendered.output).toContain("Select PR");
      expect(rendered.output).toContain("Profile");
    } finally {
      rendered.unmount();
    }
  });

  test("from PR form shows Refresh row at the bottom of the PR list", async () => {
    const rendered = await renderNode(
      <FromPRForm
        prList={[
          {
            number: 1,
            title: "First PR",
            state: "OPEN",
            headRefName: "feat-1",
            rollupState: null,
          },
        ]}
        profileNames={[]}
        isRefreshing={false}
        onRefresh={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
        width={80}
      />,
    );

    try {
      expect(rendered.output).toContain("↻ Refresh PRs");
    } finally {
      rendered.unmount();
    }
  });

  test("from PR form shows Loading label on Refresh row when isRefreshing", async () => {
    const rendered = await renderNode(
      <FromPRForm
        prList={[]}
        profileNames={[]}
        isRefreshing={true}
        onRefresh={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
        width={80}
      />,
    );

    try {
      expect(rendered.output).toContain("↻ Loading...");
      expect(rendered.output).not.toContain("↻ Refresh PRs");
    } finally {
      rendered.unmount();
    }
  });

  test("from PR form cursor stays on PR row (not Refresh row) when isRefreshing=true with one PR", async () => {
    // When isRefreshing=true, selectedPRIndex starts at 0 (on the PR), not on the Refresh row.
    // The ▸ cursor marker should appear next to the PR label, not on "↻ Loading...".
    const rendered = await renderNode(
      <FromPRForm
        prList={[
          {
            number: 42,
            title: "Some PR",
            state: "OPEN",
            headRefName: "feat-42",
            rollupState: null,
          },
        ]}
        profileNames={[]}
        isRefreshing={true}
        onRefresh={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
        width={80}
      />,
    );

    try {
      // The PR row should have the cursor marker
      expect(rendered.output).toContain("▸ #42 feat-42");
      // The loading row must not have the cursor marker
      expect(rendered.output).not.toContain("▸ ↻ Loading...");
    } finally {
      rendered.unmount();
    }
  });

  test("OpenModal always passes an AbortSignal to onRefresh (both auto and manual)", async () => {
    // Gap 2: The bound onRefresh passed to FromPRForm uses abortControllerRef.current?.signal,
    // so every call — auto-on-open and future manual calls — carries a signal.
    const onRefresh = vi.fn();

    const rendered = await renderNode(
      <OpenModal
        visible
        width={60}
        defaultBase="main"
        profileNames={[]}
        repoProject="myproj"
        repoPath="/repo"
        prList={[]}
        isRefreshing={false}
        onRefresh={onRefresh}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    try {
      // The auto-on-open refresh fires with a signal (verifies the controller path)
      expect(onRefresh).toHaveBeenCalled();
      const lastSignal =
        onRefresh.mock.calls[onRefresh.mock.calls.length - 1][0];
      expect(lastSignal).toBeInstanceOf(AbortSignal);
    } finally {
      rendered.unmount();
    }
  });

  test("existing branch form shows profiles when they are configured", async () => {
    runPromiseMock.mockResolvedValueOnce(["feature-a", "feature-b"]);

    const rendered = await renderNode(
      <ExistingBranchForm
        repoPath="/repo"
        profileNames={["backend"]}
        onSubmit={() => {}}
        onBack={() => {}}
        width={80}
      />,
    );

    try {
      expect(rendered.output).toContain("No IDE");
      expect(rendered.output).toContain("Auto-switch");
      expect(rendered.output).not.toContain("No attach");
      expect(rendered.output).toContain("Profile");
      expect(rendered.output).toContain("(default)");
      expect(rendered.output).toContain("backend");
    } finally {
      rendered.unmount();
    }
  });
});

describe("OpenModal", () => {
  afterEach(() => {
    vi.clearAllMocks();
    runPromiseMock.mockReset();
  });

  test("calls onRefresh once on mount with an AbortSignal", async () => {
    const onRefresh = vi.fn();
    const rendered = await renderNode(
      <OpenModal
        visible
        width={60}
        defaultBase="main"
        profileNames={[]}
        repoProject="myproj"
        repoPath="/repo"
        prList={[]}
        isRefreshing={false}
        onRefresh={onRefresh}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    try {
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(onRefresh.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    } finally {
      rendered.unmount();
    }
  });

  test("signal passed to onRefresh is aborted after unmount", async () => {
    const signals: AbortSignal[] = [];
    const onRefresh = vi.fn((signal?: AbortSignal) => {
      if (signal) signals.push(signal);
    });

    const rendered = await renderNode(
      <OpenModal
        visible
        width={60}
        defaultBase="main"
        profileNames={[]}
        repoProject="myproj"
        repoPath="/repo"
        prList={[]}
        isRefreshing={false}
        onRefresh={onRefresh}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(onRefresh).toHaveBeenCalled();
    // Collect all signals passed to onRefresh — after unmount ALL must be aborted
    // (intermediate ones from React effect re-runs in test env may already be aborted)
    rendered.unmount();
    for (const signal of signals) {
      expect(signal.aborted).toBe(true);
    }
  });

  test("shows Updating indicator in title when isRefreshing", async () => {
    const rendered = await renderNode(
      <OpenModal
        visible
        width={60}
        defaultBase="main"
        profileNames={[]}
        repoProject="myproj"
        repoPath="/repo"
        prList={[]}
        isRefreshing={true}
        onRefresh={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    try {
      expect(rendered.output).toContain("↻ Updating…");
    } finally {
      rendered.unmount();
    }
  });
});

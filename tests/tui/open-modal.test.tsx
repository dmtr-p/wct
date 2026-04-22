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

const { ExistingBranchForm, FromPRForm, NewBranchForm } = await import(
  "../../src/tui/components/OpenModal"
);

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

  test("new branch form shows No IDE and No attach toggles", async () => {
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
      expect(rendered.output).toContain("No attach");
    } finally {
      rendered.unmount();
    }
  });

  test("from PR form shows No IDE and No attach toggles", async () => {
    const rendered = await renderNode(
      <FromPRForm
        prList={[
          {
            number: 123,
            title: "Feature from PR",
            state: "OPEN",
            headRefName: "feature-from-pr",
            checks: [],
          },
        ]}
        profileNames={[]}
        onSubmit={() => {}}
        onBack={() => {}}
        width={80}
      />,
    );

    try {
      expect(rendered.output).toContain("No IDE");
      expect(rendered.output).toContain("No attach");
    } finally {
      rendered.unmount();
    }
  });

  test("existing branch form shows No IDE and No attach toggles", async () => {
    runPromiseMock.mockResolvedValueOnce(["feature-a", "feature-b"]);

    const rendered = await renderNode(
      <ExistingBranchForm
        repoPath="/repo"
        onSubmit={() => {}}
        onBack={() => {}}
        width={80}
      />,
    );

    try {
      expect(rendered.output).toContain("No IDE");
      expect(rendered.output).toContain("No attach");
    } finally {
      rendered.unmount();
    }
  });
});

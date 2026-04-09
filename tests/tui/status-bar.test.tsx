import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { StatusBar } from "../../src/tui/components/StatusBar";
import { Mode } from "../../src/tui/types";

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 80;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

async function waitForOutput(chunks: string[], attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (chunks.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function renderStatusBar(props: React.ComponentProps<typeof StatusBar>) {
  const { stdout, stdin } = createStdoutStdin();
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  const { render } = await import("ink");
  const instance = render(React.createElement(StatusBar, props), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await waitForOutput(chunks);

  return {
    output: chunks.join(""),
    unmount() {
      instance.unmount();
    },
  };
}

describe("StatusBar", () => {
  test("shows pane hints for expanded pane rows", async () => {
    const rendered = await renderStatusBar({
      mode: Mode.Expanded("proj/branch"),
      selectedPaneRow: true,
    });

    expect(rendered.output).toContain(
      "↑↓:navigate  ←:collapse  space:jump  z:zoom  x:kill",
    );
    expect(rendered.output).toContain("/:search  q:quit");

    rendered.unmount();
  });

  test("shows generic expanded hints for non-pane rows", async () => {
    const rendered = await renderStatusBar({
      mode: Mode.Expanded("proj/branch"),
      selectedPaneRow: false,
    });

    expect(rendered.output).toContain(
      "↑↓:navigate  ←:collapse  space:action  o:open",
    );
    expect(rendered.output).toContain("/:search  q:quit");

    rendered.unmount();
  });

  test("shows the kill confirmation prompt", async () => {
    const rendered = await renderStatusBar({
      mode: Mode.ConfirmKill("%1", "shell:1 vim", "proj/branch"),
    });

    expect(rendered.output).toContain("Kill pane shell:1 vim?");
    expect(rendered.output).toContain("enter:confirm  esc:cancel");

    rendered.unmount();
  });
});

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
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

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
    expect(rendered.output).toContain(
      "u:up  d:down  c:close  /:search  q:quit",
    );

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

  test("shows the down confirmation prompt", async () => {
    const rendered = await renderStatusBar({
      mode: Mode.ConfirmDown(
        "myapp-feature",
        "feature",
        "/tmp/myapp-feature",
        "proj/feature",
      ),
    });

    expect(rendered.output).toContain("Kill session for feature?");
    expect(rendered.output).toContain("enter:confirm  esc:cancel");

    rendered.unmount();
  });

  test("hides tmux-mutating hints in Navigate mode when no client", async () => {
    const rendered = await renderStatusBar({
      mode: Mode.Navigate,
      hasClient: false,
    });

    expect(rendered.output).toContain("↑↓:navigate");
    expect(rendered.output).toContain("o:open");
    expect(rendered.output).not.toContain("space:switch");
    expect(rendered.output).toContain("u:up");
    expect(rendered.output).not.toContain("d:down");
    expect(rendered.output).toContain("c:close");

    rendered.unmount();
  });

  test("hides tmux-mutating hints in Expanded mode when no client", async () => {
    const rendered = await renderStatusBar({
      mode: Mode.Expanded("proj/branch"),
      selectedPaneRow: false,
      hasClient: false,
    });

    expect(rendered.output).toContain("↑↓:navigate");
    expect(rendered.output).toContain("o:open");
    expect(rendered.output).not.toContain("space:action");
    expect(rendered.output).toContain("u:up");
    expect(rendered.output).not.toContain("d:down");
    expect(rendered.output).toContain("c:close");

    rendered.unmount();
  });

  test("hides pane hints in Expanded pane row when no client", async () => {
    const rendered = await renderStatusBar({
      mode: Mode.Expanded("proj/branch"),
      selectedPaneRow: true,
      hasClient: false,
    });

    expect(rendered.output).toContain("↑↓:navigate");
    expect(rendered.output).not.toContain("space:jump");
    expect(rendered.output).not.toContain("z:zoom");
    expect(rendered.output).not.toContain("x:kill");

    rendered.unmount();
  });
});

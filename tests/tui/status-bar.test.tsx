import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import {
  StatusBar,
  singleLineFooterText,
} from "../../src/tui/components/StatusBar";
import { Mode } from "../../src/tui/types";

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};

function createStdoutStdin(columns = 80) {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = columns;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

async function renderStatusBar(
  props: React.ComponentProps<typeof StatusBar>,
  columns = 80,
) {
  const { stdout, stdin } = createStdoutStdin(columns);
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
  test("normalizes multiline footer messages to one row", () => {
    expect(singleLineFooterText("first line\nsecond line\r\nthird")).toBe(
      "first line second line third",
    );
  });

  test("keeps a long multiline error within its single footer row", async () => {
    const rendered = await renderStatusBar(
      {
        mode: Mode.Navigate,
        repoError: `first line\n${"second line ".repeat(10)}`,
      },
      20,
    );

    expect(rendered.output.trim().split("\n")).toHaveLength(4);
    expect(rendered.output).toContain("⚠ first line second");
    rendered.unmount();
  });

  test("shows detail expansion without repo collapse hints", async () => {
    const rendered = await renderStatusBar({ mode: Mode.Navigate });

    expect(rendered.output).toContain("↑↓:navigate  →:details");
    expect(rendered.output).not.toContain("expand/collapse");

    rendered.unmount();
  });

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
      "↑↓:navigate  ←:collapse  space:action  o:open  a:add",
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
    expect(rendered.output).toContain("a:add");
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
    expect(rendered.output).toContain("a:add");
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

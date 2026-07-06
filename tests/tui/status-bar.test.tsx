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
    lastFrame: () => chunks[chunks.length - 1] ?? "",
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

  // App.tsx budgets bottomChromeRows assuming every StatusBar line occupies
  // exactly one terminal row — a hint or error line wrapping in a narrow
  // terminal would silently overflow the viewport and misalign mouse
  // hit-testing, so these pin the truncate behaviour at widths where the
  // hint text is longer than the terminal.
  describe("narrow terminals (one row per chrome line)", () => {
    test("Navigate hints truncate instead of wrapping", async () => {
      // With a client, line1 is ~60 chars — well past 40 columns.
      const rendered = await renderStatusBar(
        { mode: Mode.Navigate, hasClient: true },
        40,
      );

      // divider + 2 hint lines, regardless of hint text length.
      expect(rendered.lastFrame().trimEnd().split("\n")).toHaveLength(3);
      expect(rendered.output).toContain("↑↓:navigate");

      rendered.unmount();
    });

    test("a long repoError line truncates instead of wrapping", async () => {
      const rendered = await renderStatusBar(
        {
          mode: Mode.Navigate,
          hasClient: false,
          repoError:
            "gh: HTTP 502 from api.github.com while fetching pull requests for a-very-long-project-name",
        },
        40,
      );

      // divider + repoError + 2 hint lines.
      expect(rendered.lastFrame().trimEnd().split("\n")).toHaveLength(4);
      expect(rendered.output).toContain("⚠ gh: HTTP 502");

      rendered.unmount();
    });
  });
});

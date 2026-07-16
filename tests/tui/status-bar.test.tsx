import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import {
  StatusBar,
  statusBarRowCount,
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
    lastFrame: () => chunks[chunks.length - 1] ?? "",
    unmount() {
      instance.unmount();
    },
  };
}

describe("StatusBar", () => {
  test("hides shortcut hints in Expanded mode", async () => {
    const rendered = await renderStatusBar({
      mode: Mode.Expanded("proj/branch"),
      selectedPaneRow: true,
      canCollapse: true,
    });

    expect(rendered.output).not.toContain("↑↓:navigate");
    expect(rendered.output).not.toContain("space:jump");
    expect(rendered.lastFrame()).toBe("");

    rendered.unmount();
  });

  test("hides shortcut hints in Navigate mode", async () => {
    const rendered = await renderStatusBar({
      mode: Mode.Navigate,
      hasClient: true,
    });

    expect(rendered.output).not.toContain("↑↓:navigate");
    expect(rendered.output).not.toContain("q:quit");
    expect(rendered.lastFrame()).toBe("");

    rendered.unmount();
  });

  test("does not duplicate the anchored kill confirmation", async () => {
    const rendered = await renderStatusBar({
      mode: Mode.ConfirmKill("%1", "shell:1 vim", "proj/branch"),
    });

    expect(rendered.lastFrame()).toBe("");

    rendered.unmount();
  });

  test("does not duplicate the anchored down confirmation", async () => {
    const rendered = await renderStatusBar({
      mode: Mode.ConfirmDown(
        "myapp-feature",
        "feature",
        "/tmp/myapp-feature",
        "proj/feature",
      ),
    });

    expect(rendered.lastFrame()).toBe("");

    rendered.unmount();
  });

  // App.tsx budgets bottomChromeRows assuming every StatusBar line occupies
  // exactly one terminal row — a hint or error line wrapping in a narrow
  // terminal would silently overflow the viewport and misalign mouse
  // hit-testing, so these pin the truncate behaviour at widths where the
  // hint text is longer than the terminal.
  describe("narrow terminals (one row per chrome line)", () => {
    test("Navigate renders no footer without an error", async () => {
      const rendered = await renderStatusBar(
        { mode: Mode.Navigate, hasClient: true },
        40,
      );

      expect(rendered.lastFrame()).toBe("");

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

      expect(rendered.lastFrame().trimEnd().split("\n")).toHaveLength(1);
      expect(rendered.output).toContain("⚠ gh: HTTP 502");

      rendered.unmount();
    });

    test("a multi-line repoError renders on a single row", async () => {
      const rendered = await renderStatusBar(
        {
          mode: Mode.Navigate,
          hasClient: false,
          // wrap="truncate" does not remove embedded newlines, so without
          // toSingleLine this would render 2+ rows and break the viewport
          // budget that counts every chrome line as exactly one row.
          repoError: "gh: HTTP 502\nadvice: try again later",
        },
        80,
      );

      expect(rendered.lastFrame().trimEnd().split("\n")).toHaveLength(1);
      expect(rendered.output).toContain(
        "⚠ gh: HTTP 502 advice: try again later",
      );

      rendered.unmount();
    });
  });

  describe("statusBarRowCount stays true to the render", () => {
    // The anti-drift contract: App.tsx budgets the tree viewport with
    // statusBarRowCount, so for every renderable mode the helper must equal
    // the row count StatusBar actually produces.
    const cases: Array<{
      name: string;
      mode: Mode;
      repoError?: string;
    }> = [
      { name: "Navigate", mode: Mode.Navigate },
      { name: "Navigate + repoError", mode: Mode.Navigate, repoError: "boom" },
      { name: "Expanded", mode: Mode.Expanded("proj/branch") },
      {
        name: "Expanded + repoError",
        mode: Mode.Expanded("proj/branch"),
        repoError: "boom",
      },
      { name: "Search", mode: Mode.Search },
      // Search's early return ignores repoError; the count must match that.
      { name: "Search + repoError", mode: Mode.Search, repoError: "boom" },
      {
        name: "ConfirmKill",
        mode: Mode.ConfirmKill("%1", "1:0 vim", "proj/branch"),
        repoError: "boom",
      },
    ];

    for (const { name, mode, repoError } of cases) {
      test(name, async () => {
        const rendered = await renderStatusBar({
          mode,
          hasClient: true,
          searchQuery: "",
          repoError,
        });

        const frame = rendered.lastFrame().trimEnd();
        const renderedRows = frame ? frame.split("\n").length : 0;
        expect(renderedRows).toBe(statusBarRowCount(mode, Boolean(repoError)));

        rendered.unmount();
      });
    }
  });
});

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { WorktreeItem } from "../../src/tui/components/WorktreeItem";
import { WorktreeStatsRow } from "../../src/tui/components/WorktreeStatsRow";
import { truncateBranch } from "../../src/tui/utils/truncate";

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

async function renderElement(node: React.ReactElement) {
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

  return {
    output: chunks.join(""),
    unmount() {
      instance.unmount();
    },
  };
}

function renderWorktreeItem(props: React.ComponentProps<typeof WorktreeItem>) {
  return renderElement(React.createElement(WorktreeItem, props));
}

const baseWorktreeProps = {
  branch: "feature/layout",
  hasSession: true,
  isAttached: false,
  isSelected: false,
  isExpanded: false,
  maxWidth: 80,
} satisfies React.ComponentProps<typeof WorktreeItem>;

describe("truncateBranch", () => {
  test("returns branch unchanged when it fits", () => {
    expect(truncateBranch("feat/auth", 20)).toBe("feat/auth");
  });

  test("returns branch unchanged when exactly at limit", () => {
    expect(truncateBranch("feat/auth", 9)).toBe("feat/auth");
  });

  test("truncates with ellipsis when too long", () => {
    expect(truncateBranch("feature/very-long-branch-name", 15)).toBe(
      "feature/very-l…",
    );
  });

  test("handles very small available space", () => {
    expect(truncateBranch("feature/branch", 3)).toBe("fe…");
  });

  test("handles available less than the text length", () => {
    expect(truncateBranch("feature/branch", 2)).toBe("f…");
    expect(truncateBranch("feature/branch", 1)).toBe("…");
  });

  test("returns empty string when no space is available", () => {
    expect(truncateBranch("feature/branch", 0)).toBe("");
  });
});

describe("WorktreeItem", () => {
  test("renders the branch and never the git stats (stats moved to WorktreeStatsRow)", async () => {
    const { output, unmount } = await renderWorktreeItem({
      ...baseWorktreeProps,
      isSelected: true,
      isExpanded: true,
    });

    expect(output).toContain("feature/layout");
    // Stats are no longer part of WorktreeItem — they render as a separate row.
    expect(output).not.toContain("↑1");
    expect(output).not.toContain("~3");

    unmount();
  });
});

describe("WorktreeStatsRow", () => {
  test("renders sync and changed-file stats", async () => {
    const { output, unmount } = await renderElement(
      React.createElement(WorktreeStatsRow, { sync: "↑1", changedFiles: 3 }),
    );

    expect(output).toContain("↑1");
    expect(output).toContain("~3");

    unmount();
  });

  test("omits the changed-file marker when there are no changes", async () => {
    const { output, unmount } = await renderElement(
      React.createElement(WorktreeStatsRow, { sync: "↑1", changedFiles: 0 }),
    );

    expect(output).toContain("↑1");
    expect(output).not.toContain("~");

    unmount();
  });

  test("omits the sync marker when in sync", async () => {
    const { output, unmount } = await renderElement(
      React.createElement(WorktreeStatsRow, { sync: "✓", changedFiles: 2 }),
    );

    expect(output).not.toContain("✓");
    expect(output).toContain("~2");

    unmount();
  });
});

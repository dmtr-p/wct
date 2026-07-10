import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { WorktreeItem } from "../../src/tui/components/WorktreeItem";
import { truncateBranch } from "../../src/tui/utils/truncate";
import { elementText, hasElementProp } from "./react-elements";

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

async function renderWorktreeItem(
  props: React.ComponentProps<typeof WorktreeItem>,
) {
  const { stdout, stdin } = createStdoutStdin(props.maxWidth);
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  const { render } = await import("ink");
  const instance = render(React.createElement(WorktreeItem, props), {
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

const baseWorktreeProps = {
  branch: "feature/layout",
  hasSession: true,
  isAttached: false,
  sync: "↑1",
  changedFiles: 3,
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
  test("keeps opening and status rows single-line in a narrow terminal", async () => {
    const opening = await renderWorktreeItem({
      ...baseWorktreeProps,
      branch: "",
      pendingStatus: "opening",
      maxWidth: 8,
    });
    const expanded = await renderWorktreeItem({
      ...baseWorktreeProps,
      branch: "",
      sync: "?",
      changedFiles: 12,
      isExpanded: true,
      maxWidth: 8,
    });

    expect(opening.output.trim().split("\n")).toHaveLength(1);
    expect(expanded.output.trim().split("\n")).toHaveLength(2);
    opening.unmount();
    expanded.unmount();
  });

  test("does not render git stats for a focused collapsed worktree", async () => {
    const { output, unmount } = await renderWorktreeItem({
      ...baseWorktreeProps,
      isSelected: true,
      isExpanded: false,
    });

    expect(output).toContain("feature/layout");
    expect(output).not.toContain("↑1");
    expect(output).not.toContain("~3");

    unmount();
  });

  test("renders git stats for an expanded worktree", async () => {
    const { output, unmount } = await renderWorktreeItem({
      ...baseWorktreeProps,
      isSelected: false,
      isExpanded: true,
    });

    expect(output).toContain("↑1");
    expect(output).toContain("~3");

    unmount();
  });

  test("renders git stats for a selected expanded worktree", async () => {
    const { output, unmount } = await renderWorktreeItem({
      ...baseWorktreeProps,
      isSelected: true,
      isExpanded: true,
    });

    expect(output).toContain("↑1");
    expect(output).toContain("~3");

    unmount();
  });

  test("uses a background highlight without a cursor glyph", async () => {
    const props = {
      ...baseWorktreeProps,
      isSelected: true,
    } satisfies React.ComponentProps<typeof WorktreeItem>;
    const { output, unmount } = await renderWorktreeItem(props);

    expect(hasElementProp(WorktreeItem(props), "backgroundColor", "cyan")).toBe(
      true,
    );
    expect(hasElementProp(WorktreeItem(props), "color", "#f2f2f2")).toBe(true);
    expect(elementText(WorktreeItem(props))).toContain(
      `   ● feature/layout${" ".repeat(61)}`,
    );
    expect(output).not.toContain("❯");
    unmount();
  });
});

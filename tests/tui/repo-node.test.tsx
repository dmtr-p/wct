import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { RepoNode } from "../../src/tui/components/RepoNode";
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

async function renderRepoNode(props: React.ComponentProps<typeof RepoNode>) {
  const { stdout, stdin } = createStdoutStdin(props.maxWidth);
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  const { render } = await import("ink");
  const instance = render(React.createElement(RepoNode, props), {
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

describe("RepoNode", () => {
  test("keeps an empty repo to its modeled two rows when narrow", async () => {
    const { output, unmount } = await renderRepoNode({
      project: "r",
      isSelected: false,
      isChildSelected: false,
      worktreeCount: 0,
      maxWidth: 8,
    });

    expect(output.trimEnd().split("\n")).toHaveLength(2);
    unmount();
  });

  test("renders full project name when maxWidth is wide", async () => {
    // Only the one-column tree inset counts as overhead.
    const { output, unmount } = await renderRepoNode({
      project: "my-project",
      isSelected: false,
      isChildSelected: false,
      worktreeCount: 1,
      maxWidth: 40,
    });
    expect(output).toContain("my-project");
    unmount();
  });

  test("truncates project name when maxWidth is tight", async () => {
    // One-column inset: maxWidth=7 leaves 6 columns → "my-pr…"
    const { output, unmount } = await renderRepoNode({
      project: "my-project",
      isSelected: false,
      isChildSelected: false,
      worktreeCount: 1,
      maxWidth: 7,
    });
    expect(output).toContain("my-pr…");
    expect(output).not.toContain("my-project");
    unmount();
  });

  test("renders full name at exact available width", async () => {
    // With the one-column inset, maxWidth=11 fits exactly.
    const { output, unmount } = await renderRepoNode({
      project: "my-project",
      isSelected: false,
      isChildSelected: false,
      worktreeCount: 1,
      maxWidth: 11,
    });
    expect(output).toContain("my-project");
    unmount();
  });

  test("uses a background highlight without cursor or disclosure glyphs", async () => {
    const props = {
      project: "my-project",
      isSelected: true,
      isChildSelected: false,
      worktreeCount: 1,
      maxWidth: 40,
    } satisfies React.ComponentProps<typeof RepoNode>;
    const { output, unmount } = await renderRepoNode(props);
    expect(hasElementProp(RepoNode(props), "backgroundColor", "cyan")).toBe(
      true,
    );
    expect(hasElementProp(RepoNode(props), "color", "#f2f2f2")).toBe(true);
    expect(elementText(RepoNode(props))).toContain(
      ` my-project${" ".repeat(29)}`,
    );
    expect(output).not.toContain("❯");
    expect(output).not.toContain("▶");
    expect(output).not.toContain("▼");
    unmount();
  });
});

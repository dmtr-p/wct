import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { RepoNode } from "../../src/tui/components/RepoNode";

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

async function renderRepoNode(props: React.ComponentProps<typeof RepoNode>) {
  const { stdout, stdin } = createStdoutStdin();
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
  test("renders full project name when maxWidth is wide", async () => {
    // overhead=4, project="my-project" (10), available=36 → no truncation
    const { output, unmount } = await renderRepoNode({
      project: "my-project",
      expanded: false,
      isSelected: false,
      isChildSelected: false,
      worktreeCount: 1,
      maxWidth: 40,
    });
    expect(output).toContain("my-project");
    unmount();
  });

  test("truncates project name when maxWidth is tight", async () => {
    // overhead=4, project="my-project" (10), maxWidth=10 → available=6 → "my-..."
    const { output, unmount } = await renderRepoNode({
      project: "my-project",
      expanded: false,
      isSelected: false,
      isChildSelected: false,
      worktreeCount: 1,
      maxWidth: 10,
    });
    expect(output).toContain("my-...");
    expect(output).not.toContain("my-project");
    unmount();
  });

  test("renders full name at exact available width", async () => {
    // overhead=4, project="my-project" (10), maxWidth=14 → available=10 → fits exactly
    const { output, unmount } = await renderRepoNode({
      project: "my-project",
      expanded: false,
      isSelected: false,
      isChildSelected: false,
      worktreeCount: 1,
      maxWidth: 14,
    });
    expect(output).toContain("my-project");
    unmount();
  });
});

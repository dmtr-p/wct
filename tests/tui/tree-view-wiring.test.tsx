import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { TreeView } from "../../src/tui/components/TreeView";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { buildTreeItems } from "../../src/tui/tree-helpers";

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

describe("TreeView maxWidth wiring", () => {
  test("passes maxWidth to RepoNode — long project name is truncated", async () => {
    const repos = [
      {
        id: "repo-1",
        repoPath: "/tmp/very-long-project-name",
        project: "very-long-project-name",
        worktrees: [],
        profileNames: [],
        ideDefaults: { baseNoIde: true, profileNoIde: {} },
      },
    ];
    const expandedRepos = new Set(["repo-1"]);
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      prData: new Map(),
      panes: new Map(),
      jumpToPane: () => undefined,
    });

    const { stdout, stdin } = createStdoutStdin();
    const chunks: string[] = [];
    stdout.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });

    const { render } = await import("ink");
    const instance = render(
      React.createElement(TreeView, {
        repos,
        sessions: [],
        expandedRepos,
        selectedIndex: 0,
        items,
        pendingActions: new Map(),
        prData: new Map(),
        panes: new Map(),
        expandedWorktreeKey: null,
        maxWidth: 15,
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = chunks.join("");

    // "very-long-project-name" (22 chars), maxWidth=15, overhead=4 → available=11
    // truncateBranch("very-long-project-name", 11) → "very-long-…"
    expect(output).toContain("very-long-…");
    expect(output).not.toContain("very-long-project-name");

    instance.unmount();
  });
});

describe("TreeView windowing", () => {
  function collapsedRepos(): RepoInfo[] {
    return Array.from({ length: 6 }, (_, i) => ({
      id: `repo-${i}`,
      repoPath: `/tmp/repo-${i}`,
      project: `project-${i}`,
      worktrees: [],
      profileNames: [],
      ideDefaults: { baseNoIde: true, profileNoIde: {} },
    }));
  }

  async function renderTree(
    props: Partial<React.ComponentProps<typeof TreeView>>,
  ) {
    const repos = collapsedRepos();
    const expandedRepos = new Set<string>();
    const items = buildTreeItems({
      repos,
      expandedRepos,
      expandedWorktreeKey: null,
      prData: new Map(),
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const { stdout, stdin } = createStdoutStdin();
    const chunks: string[] = [];
    stdout.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    const { render } = await import("ink");
    const instance = render(
      React.createElement(TreeView, {
        repos,
        sessions: [],
        expandedRepos,
        selectedIndex: 0,
        items,
        pendingActions: new Map(),
        prData: new Map(),
        panes: new Map(),
        expandedWorktreeKey: null,
        maxWidth: 80,
        ...props,
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { output: chunks.join(""), unmount: () => instance.unmount() };
  }

  test("renders all rows when no viewport is supplied", async () => {
    const { output, unmount } = await renderTree({});
    for (let i = 0; i < 6; i++) {
      expect(output).toContain(`project-${i}`);
    }
    unmount();
  });

  test("renders only the windowed slice", async () => {
    // viewportRows=3, scrollOffset=2 → rows [2,3,4] → project-2/3/4 visible
    const { output, unmount } = await renderTree({
      scrollOffset: 2,
      viewportRows: 3,
    });
    expect(output).not.toContain("project-0");
    expect(output).not.toContain("project-1");
    expect(output).toContain("project-2");
    expect(output).toContain("project-3");
    expect(output).toContain("project-4");
    expect(output).not.toContain("project-5");
    unmount();
  });
});

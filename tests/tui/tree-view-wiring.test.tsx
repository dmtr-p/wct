import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import {
  RegistrationId,
  type WorkspaceIdentityKey,
} from "../../src/services/identities";
import { TreeView } from "../../src/tui/components/TreeView";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { buildTreeItems, buildTreeRows } from "../../src/tui/tree-helpers";

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
        id: RegistrationId("repo-1"),
        repoPath: "/tmp/very-long-project-name",
        project: "very-long-project-name",
        worktrees: [],
        profileNames: [],
      },
    ];
    const items = buildTreeItems({
      repos,
      expandedWorkspaceKeys: new Set<WorkspaceIdentityKey>(),
      prData: new Map(),
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    // TreeView renders the row model its owner built — the same contract
    // App.tsx uses (one buildTreeRows call shared with hit-testing).
    const rows = buildTreeRows({
      items,
      repos,
      expandedWorkspaceKeys: new Set<WorkspaceIdentityKey>(),
      maxWidth: 15,
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
        selectedIndex: 0,
        items,
        rows,
        prData: new Map(),
        panes: new Map(),
        expandedWorkspaceKeys: new Set<WorkspaceIdentityKey>(),
        maxWidth: 15,
      }),
      { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = chunks.join("");

    // The one-column tree inset leaves 14 columns for the project name.
    expect(output).toContain("very-long-pro…");
    expect(output).not.toContain("very-long-project-name");

    instance.unmount();
  });
});

describe("TreeView windowing", () => {
  function emptyRepos(): RepoInfo[] {
    return Array.from({ length: 6 }, (_, i) => ({
      id: RegistrationId(`repo-${i}`),
      repoPath: `/tmp/repo-${i}`,
      project: `project-${i}`,
      worktrees: [],
      profileNames: [],
    }));
  }

  async function renderTree(
    props: Partial<React.ComponentProps<typeof TreeView>>,
  ) {
    const repos = emptyRepos();
    const items = buildTreeItems({
      repos,
      expandedWorkspaceKeys: new Set<WorkspaceIdentityKey>(),
      prData: new Map(),
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items,
      repos,
      expandedWorkspaceKeys: new Set<WorkspaceIdentityKey>(),
      maxWidth: 80,
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
        selectedIndex: 0,
        items,
        rows,
        prData: new Map(),
        panes: new Map(),
        expandedWorkspaceKeys: new Set<WorkspaceIdentityKey>(),
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
    // Rows [2,3,4] contain project-1, its empty row, and project-2.
    const { output, unmount } = await renderTree({
      scrollOffset: 2,
      viewportRows: 3,
    });
    expect(output).not.toContain("project-0");
    expect(output).toContain("project-1");
    expect(output).toContain("project-2");
    expect(output).toContain("(no worktrees)");
    expect(output).not.toContain("project-3");
    expect(output).not.toContain("project-4");
    expect(output).not.toContain("project-5");
    unmount();
  });
});

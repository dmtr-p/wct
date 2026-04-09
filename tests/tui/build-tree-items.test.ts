import { basename } from "node:path";
import { describe, expect, test } from "vitest";
import { formatSessionName } from "../../src/services/tmux";
import { buildTreeItems, resolveSelectedPane } from "../../src/tui/App";
import { type PaneInfo, pendingKey } from "../../src/tui/types";

describe("buildTreeItems", () => {
  test("passes zoomed and active pane metadata into pane detail rows", () => {
    const repoPath = "/tmp/example-repo";
    const branch = "feature/zoomed-pane";
    const sessionName = formatSessionName(basename("/tmp/worktree-one"));
    const panes: PaneInfo[] = [
      {
        paneId: "%1",
        paneIndex: 0,
        command: "bun run dev",
        window: "main",
        zoomed: true,
        active: true,
      },
    ];

    const items = buildTreeItems({
      repos: [
        {
          id: "repo-1",
          repoPath,
          project: "example",
          worktrees: [
            {
              branch,
              path: "/tmp/worktree-one",
              isMainWorktree: true,
              changedFiles: 0,
              sync: null,
            },
          ],
          profileNames: [],
        },
      ],
      expandedRepos: new Set(["repo-1"]),
      expandedWorktreeKey: pendingKey("example", branch),
      prData: new Map(),
      panes: new Map([[sessionName, panes]]),
      jumpToPane: () => undefined,
    });

    const paneItem = items.find(
      (item) => item.type === "detail" && item.detailKind === "pane",
    );

    expect(paneItem?.meta).toEqual({ zoomed: true, active: true });
  });

  test("resolves the selected pane from session/window/pane index data", () => {
    const branch = "feature/pane-actions";
    const repoPath = "/tmp/example-repo";
    const worktreePath = "/tmp/worktree-pane-actions";
    const sessionName = formatSessionName(basename(worktreePath));
    const sessionPanes: PaneInfo[] = [
      {
        paneId: "%1",
        paneIndex: 0,
        command: "bun run dev",
        window: "editor",
        zoomed: false,
        active: false,
      },
      {
        paneId: "%2",
        paneIndex: 1,
        command: "git status",
        window: "editor",
        zoomed: true,
        active: true,
      },
    ];

    const items = buildTreeItems({
      repos: [
        {
          id: "repo-1",
          repoPath,
          project: "example",
          worktrees: [
            {
              branch,
              path: worktreePath,
              isMainWorktree: false,
              changedFiles: 0,
              sync: null,
            },
          ],
          profileNames: [],
        },
      ],
      expandedRepos: new Set(["repo-1"]),
      expandedWorktreeKey: pendingKey("example", branch),
      prData: new Map(),
      panes: new Map([[sessionName, sessionPanes]]),
      jumpToPane: () => undefined,
    });

    const selectedIndex = items.findIndex(
      (item) =>
        item.type === "detail" &&
        item.detailKind === "pane" &&
        item.label === "editor:1 git status",
    );

    const resolved = resolveSelectedPane({
      repos: [
        {
          id: "repo-1",
          repoPath,
          project: "example",
          worktrees: [
            {
              branch,
              path: worktreePath,
              isMainWorktree: false,
              changedFiles: 0,
              sync: null,
            },
          ],
          profileNames: [],
        },
      ],
      items,
      panes: new Map([
        [
          sessionName,
          [
            { ...sessionPanes[0], paneId: "%9", zoomed: true, active: true },
            { ...sessionPanes[1], command: "htop" },
          ],
        ],
      ]),
      selectedIndex,
    });

    expect(resolved).toEqual({
      pane: { ...sessionPanes[1], command: "htop" },
      label: "editor:1 git status",
      worktreeKey: pendingKey("example", branch),
    });
  });
});

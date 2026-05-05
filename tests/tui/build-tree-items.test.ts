import { basename } from "node:path";
import { describe, expect, test } from "vitest";
import { formatSessionName } from "../../src/services/tmux";
import {
  buildTreeItems,
  findOwningWorktreeIndex,
  resolveSelectedPane,
} from "../../src/tui/tree-helpers";
import { type PaneInfo, pendingKey, type TreeItem } from "../../src/tui/types";

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

    expect(paneItem?.meta).toEqual({
      paneId: "%1",
      zoomed: true,
      active: true,
      window: "main",
      paneIndex: 0,
      command: "bun run dev",
    });
  });

  test("resolves the selected pane from stable pane identity", () => {
    const branch = "feature/pane-actions";
    const repoPath = "/tmp/example-repo";
    const worktreePath = "/tmp/worktree-pane-actions";
    const sessionName = formatSessionName(basename(worktreePath));
    const pane0: PaneInfo = {
      paneId: "%1",
      paneIndex: 0,
      command: "bun run dev",
      window: "editor",
      zoomed: false,
      active: false,
    };
    const pane1: PaneInfo = {
      paneId: "%2",
      paneIndex: 1,
      command: "git status",
      window: "editor",
      zoomed: true,
      active: true,
    };
    const sessionPanes: PaneInfo[] = [pane0, pane1];

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
        item.meta?.paneId === "%2",
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
            { ...pane0, paneId: "%9", zoomed: true, active: true },
            {
              ...pane1,
              command: "htop",
              window: "renamed-window",
              paneIndex: 4,
            },
          ],
        ],
      ]),
      selectedIndex,
    });

    expect(resolved).toEqual({
      pane: {
        ...pane1,
        command: "htop",
        window: "renamed-window",
        paneIndex: 4,
      },
      label: "editor:1 git status",
      worktreeKey: pendingKey("example", branch),
    });
  });

  test("resolves the correct pane when multiple pane rows share the same label", () => {
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
      {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane",
        label: "shared label",
        meta: {
          paneId: "%1",
          zoomed: false,
          active: false,
          window: "main",
          paneIndex: 0,
          command: "bash",
        },
      },
      {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane",
        label: "shared label",
        meta: {
          paneId: "%2",
          zoomed: true,
          active: true,
          window: "main",
          paneIndex: 1,
          command: "top",
        },
      },
    ];

    const resolved = resolveSelectedPane({
      repos: [
        {
          id: "repo-1",
          repoPath: "/tmp/example-repo",
          project: "example",
          worktrees: [
            {
              branch: "feature/duplicate-labels",
              path: "/tmp/worktree-duplicate-labels",
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
          formatSessionName(basename("/tmp/worktree-duplicate-labels")),
          [
            {
              paneId: "%1",
              paneIndex: 0,
              command: "bash",
              window: "main",
              zoomed: false,
              active: false,
            },
            {
              paneId: "%2",
              paneIndex: 1,
              command: "top",
              window: "main",
              zoomed: true,
              active: true,
            },
          ],
        ],
      ]),
      selectedIndex: 3,
    });

    expect(resolved?.pane.paneId).toBe("%2");
  });

  test("finds the owning worktree row for a selected detail row", () => {
    const items: TreeItem[] = [
      { type: "repo", repoIndex: 0 },
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
      {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane-header",
        label: "Panes (1)",
      },
      {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane",
        label: "editor:0 bash",
        meta: {
          paneId: "%1",
          zoomed: false,
          active: true,
          window: "editor",
          paneIndex: 0,
          command: "bash",
        },
      },
    ];

    expect(findOwningWorktreeIndex(items, 3)).toBe(1);
    expect(findOwningWorktreeIndex(items, 1)).toBe(1);
    expect(findOwningWorktreeIndex(items, 0)).toBeNull();
  });
});

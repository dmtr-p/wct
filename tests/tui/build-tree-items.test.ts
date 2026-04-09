import { basename } from "node:path";
import { describe, expect, test } from "vitest";
import { formatSessionName } from "../../src/services/tmux";
import { buildTreeItems } from "../../src/tui/App";
import { pendingKey, type PaneInfo } from "../../src/tui/types";

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
});

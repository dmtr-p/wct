import { describe, expect, test, vi } from "vitest";
import { classifyAgent, reconcileAgent } from "../../src/services/agent-model";
import { DetailRow } from "../../src/tui/components/DetailRow";
import { WorktreeItem } from "../../src/tui/components/WorktreeItem";
import {
  sameAgentSnapshot,
  workspaceAgentSummaries,
} from "../../src/tui/hooks/useAgents";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { workspaceIdentityKey } from "../../src/tui/lifecycle";
import { buildTreeItems, buildTreeRows } from "../../src/tui/tree-helpers";
import { worktreeDisplayKey } from "../../src/tui/types";
import { displayWidth } from "../../src/tui/utils/display-width";
import { elementText } from "./react-elements";

const agent = reconcileAgent(
  undefined,
  "codex",
  "g",
  classifyAgent("codex", "", "⠋ busy"),
  0,
);
const repo: RepoInfo = {
  id: "r",
  repoPath: "/repo",
  project: "duplicate",
  profileNames: [],
  worktrees: [
    {
      branch: "feature",
      path: "/work/workspace",
      isMainWorktree: false,
      changedFiles: 0,
      sync: null,
    },
  ],
};

describe("agent presentation", () => {
  test("Workspace summaries are keyed by identity, including collapsed and detached Workspaces", () => {
    const worktree = repo.worktrees[0];
    if (!worktree) throw new Error("Missing Workspace fixture");
    const other = {
      ...repo,
      id: "other",
      repoPath: "/other",
      worktrees: [{ ...worktree, path: "/work/other-session" }],
    };
    const summaries = workspaceAgentSummaries([repo, other], {
      observations: new Map([["%1", agent]]),
      memberships: new Map([["workspace", new Set(["%1"])]]),
    });
    expect(summaries.get(workspaceIdentityKey("/repo", "feature"))).toBe(
      "1 working",
    );
    expect(summaries.get(workspaceIdentityKey("/other", "feature"))).toBe("");
  });
  test("pane labels retain stable IDs/actions and a single visual row", () => {
    const jump = vi.fn();
    const items = buildTreeItems({
      repos: [repo],
      expandedWorktreeKeys: new Set([
        worktreeDisplayKey(repo.project, "feature"),
      ]),
      prData: new Map(),
      agents: new Map([["%1", agent]]),
      panes: new Map([
        [
          "workspace",
          [
            {
              paneId: "%1",
              paneIndex: 0,
              command: "codex",
              window: "main",
              zoomed: false,
              active: true,
            },
          ],
        ],
      ]),
      jumpToPane: jump,
    });
    const pane = items.find(
      (item) => item.type === "detail" && item.detailKind === "pane",
    );
    if (pane?.type !== "detail" || pane.detailKind !== "pane")
      throw new Error("Missing pane");
    expect(pane.meta.paneId).toBe("%1");
    expect(pane.meta.agent).toBe(agent);
    pane.action?.();
    expect(jump).toHaveBeenCalledWith("%1");
    const rows = buildTreeRows({
      items,
      repos: [repo],
      maxWidth: 40,
      expandedWorktreeKeys: new Set([
        worktreeDisplayKey(repo.project, "feature"),
      ]),
    });
    expect(
      rows.filter((row) => row.itemIndex === items.indexOf(pane)),
    ).toHaveLength(1);
    const text = elementText(
      DetailRow({ item: pane, isSelected: true, maxWidth: 60 }),
    );
    expect(text).toContain("codex · working");
    expect(displayWidth(text)).toBe(60);
  });
  test("Workspace counts reserve width and retain short branch names", () => {
    const props = {
      branch: "feat",
      hasSession: true,
      isAttached: true,
      isSelected: true,
      maxWidth: 80,
      agentSummary: "1 blocked · 1 working",
    };
    const text = elementText(WorktreeItem(props));
    expect(text).toContain("feat");
    expect(text).toContain("[1 blocked · 1 working]");
    expect(displayWidth(text)).toBe(80);
    for (const maxWidth of [18, 24, 40]) {
      const narrow = elementText(
        WorktreeItem({
          ...props,
          branch: "界".repeat(40),
          maxWidth,
          isExpanded: true,
        }),
      );
      expect(narrow).not.toContain("\n");
      expect(displayWidth(narrow)).toBe(maxWidth);
    }
  });
  test("timestamps do not rerender, freshness/membership changes do", () => {
    const snapshot = {
      observations: new Map([["%1", agent]]),
      memberships: new Map([["workspace", new Set(["%1"])]]),
    };
    expect(
      sameAgentSnapshot(snapshot, {
        ...snapshot,
        observations: new Map([["%1", { ...agent, observedAt: 1000 }]]),
      }),
    ).toBe(true);
    expect(
      sameAgentSnapshot(snapshot, {
        ...snapshot,
        observations: new Map([["%1", { ...agent, freshness: "stale" }]]),
      }),
    ).toBe(false);
    expect(
      sameAgentSnapshot(snapshot, { ...snapshot, memberships: new Map() }),
    ).toBe(false);
  });
});

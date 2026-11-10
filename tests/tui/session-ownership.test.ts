import { describe, expect, test } from "vitest";
import { classifyAgent, reconcileAgent } from "../../src/services/agent-model";
import { RegistrationId } from "../../src/services/identities";
import {
  sessionIdentity,
  workspaceSessionName,
} from "../../src/services/session-identity";
import { buildAgentList } from "../../src/tui/agent-view";
import {
  projectWorkspaceAgents,
  workspaceAgentSummaries,
} from "../../src/tui/hooks/useAgents";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { workspaceIdentityKey } from "../../src/tui/lifecycle";
import { workspacePaneMap } from "../../src/tui/session-utils";
import { legacySession } from "../helpers/session-projections";

const target = {
  mainRepoPath: "/repos/a",
  worktreePath: "/work/api",
  branch: "feature",
};
const repo: RepoInfo = {
  id: RegistrationId("a"),
  repoPath: target.mainRepoPath,
  project: "api",
  profileNames: [],
  worktrees: [
    {
      path: target.worktreePath,
      branch: target.branch,
      isMainWorktree: false,
      changedFiles: 0,
      sync: null,
    },
  ],
};
const pane = {
  paneId: "%1",
  paneIndex: 0,
  command: "codex",
  title: "Work",
  window: "main",
  zoomed: false,
  active: true,
};
const observation = reconcileAgent(
  undefined,
  "codex",
  "generation",
  classifyAgent("codex", "", "⠋ busy"),
  0,
);

describe("Workspace session discovery", () => {
  test.each(["legacy", "hashed"])(
    "panes and agents agree for verified %s sessions",
    (kind) => {
      const session =
        kind === "legacy"
          ? legacySession(target)
          : {
              ...legacySession(target),
              name: workspaceSessionName(target),
              ownership: { identity: sessionIdentity(target) },
            };
      const panes = workspacePaneMap(
        [repo],
        [session],
        new Map([[session.name, [pane]]]),
      );
      const agents = projectWorkspaceAgents([repo], [session], {
        observations: new Map([[pane.paneId, observation]]),
        memberships: new Map([[session.name, new Set([pane.paneId])]]),
      });
      expect(panes.get(workspaceSessionName(target))).toEqual([pane]);
      expect(buildAgentList([repo], agents, panes).items).toMatchObject([
        { paneId: pane.paneId, repoPath: repo.repoPath, title: "Work" },
      ]);
      expect(
        workspaceAgentSummaries([repo], agents).get(
          workspaceIdentityKey(repo.repoPath, target.branch),
        ),
      ).toBe("1 working");
    },
  );

  test.each(["untagged", "foreign"])(
    "does not attribute %s sessions even with matching names",
    (kind) => {
      const session = {
        ...legacySession(target),
        name: workspaceSessionName(target),
        ownership:
          kind === "untagged"
            ? {}
            : {
                identity: sessionIdentity({
                  ...target,
                  mainRepoPath: "/repos/b",
                }),
              },
      };
      const panes = workspacePaneMap(
        [repo],
        [session],
        new Map([[session.name, [pane]]]),
      );
      const agents = projectWorkspaceAgents([repo], [session], {
        observations: new Map([[pane.paneId, observation]]),
        memberships: new Map([[session.name, new Set([pane.paneId])]]),
      });
      expect(panes.size).toBe(0);
      expect(agents.memberships.size).toBe(0);
      expect(buildAgentList([repo], agents, panes).items).toEqual([]);
    },
  );
});

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AgentObservation,
  AgentState,
} from "../../src/services/agent-model";
import { RegistrationId } from "../../src/services/identities";
import type { TmuxPaneInfo } from "../../src/services/tmux";
import type { WorkspaceCloseResult } from "../../src/services/workspace-service";
import { buildAgentList } from "../../src/tui/agent-view";
import type { WorkspaceAgentSnapshot } from "../../src/tui/hooks/useAgents";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import {
  lastWorkspaceCall,
  makeWorktree,
  registryItems,
  renderApp,
  resetHarnessFixtures,
  selectedLine,
  sendKeys,
  sgrPress,
  tick,
  tmuxFixtures,
  triggerRefresh,
  workspaceCalls,
  worktreeFixtures,
} from "./app-harness";

const fixtures = vi.hoisted((): { snapshot: WorkspaceAgentSnapshot } => ({
  snapshot: {
    observations: new Map(),
    memberships: new Map(),
    summaries: new Map(),
  },
}));

vi.mock("../../src/tui/hooks/useAgents", () => ({
  useAgents: () => fixtures.snapshot,
}));

const { App } = await import("../../src/tui/App");

function observation(
  pane: string,
  state: AgentState = "working",
): AgentObservation {
  return {
    agent: pane === "%2" ? "codex" : "claude",
    generation: `generation-${pane}`,
    state,
    freshness: "fresh",
    reason: "test",
    observedAt: 0,
  };
}

function pane(paneId: string, title: string): TmuxPaneInfo {
  return {
    paneId,
    paneIndex: Number(paneId.slice(1)),
    command: paneId === "%2" ? "codex" : "claude",
    window: "agent-window",
    title,
    zoomed: false,
    active: true,
  };
}

describe("App agents view", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wct-agents-view-"));
    mkdirSync(join(root, ".wct"));
    vi.stubEnv("HOME", root);
    resetHarnessFixtures();
    registryItems.items = ["alpha", "beta", "empty"].map((project) => {
      const repoPath = join(root, project);
      const worktree = makeWorktree(repoPath, `${project}-branch`);
      mkdirSync(worktree.path, { recursive: true });
      worktreeFixtures.byRepoPath.set(repoPath, [worktree]);
      return { id: RegistrationId(project), repo_path: repoPath, project };
    });
    tmuxFixtures.clients = [{ tty: "/dev/tty-test", session: "sidebar" }];
    tmuxFixtures.sessions = ["alpha-branch", "beta-branch"].map((name) => ({
      name,
      attached: false,
      windows: 1,
    }));
    tmuxFixtures.panes.set("alpha-branch", [
      pane("%1", "Add agents view toggle | wct"),
      pane("%2", "Fix navigation"),
    ]);
    tmuxFixtures.panes.set("beta-branch", [pane("%3", "Review changes")]);
    fixtures.snapshot = {
      observations: new Map([
        ["%1", observation("%1")],
        ["%2", observation("%2", "blocked")],
        ["%3", observation("%3", "idle")],
      ]),
      memberships: new Map([
        ["alpha-branch", new Set(["%1", "%2"])],
        ["beta-branch", new Set(["%3"])],
      ]),
      summaries: new Map(),
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  test("toggles views, groups agents, and switches the selected pane without worktree actions", async () => {
    const app = await renderApp(<App />);
    try {
      await tick(20);
      await sendKeys(app.stdin, "\x1b[B");
      const worktreeSelection = selectedLine(app.lines());
      const header = app.lines()[0] ?? "";
      expect(header.indexOf("[Agents]")).toBeLessThan(header.indexOf("[+Add]"));
      await sendKeys(app.stdin, "g");
      expect(app.lines()[0]).toContain("[Worktrees]");
      expect(selectedLine(app.lines())).toContain(
        "alpha-branch · Add agents view toggle | wct",
      );
      expect(app.lines().join("\n")).not.toContain("%1");
      expect(app.lines().join("\n")).toContain("working · claude");
      expect(app.lines().join("\n")).toContain("blocked · codex");
      expect(app.lines().join("\n")).toContain("idle · claude");
      expect(app.lines().join("\n")).not.toContain("empty");
      await sendKeys(app.stdin, "\r");
      await sendKeys(app.stdin, "\x1b[B");
      await sendKeys(app.stdin, " ");
      expect(tmuxFixtures.switchCalls.map((call) => call.target)).toEqual([
        "%1",
        "%2",
      ]);
      for (const key of ["c", "d", "u", "o", "\x7f"])
        await sendKeys(app.stdin, key);
      expect(workspaceCalls()).toHaveLength(0);
      expect(app.lines().join("\n")).not.toContain("Confirm");
      await sendKeys(app.stdin, "g");
      expect(selectedLine(app.lines())).toBe(worktreeSelection);
    } finally {
      app.unmount();
    }
  });

  test.each(["keyboard", "mouse"] as const)(
    "%s view changes invalidate a pending close's force confirmation",
    async (input) => {
      const app = await renderApp(<App />);
      try {
        await tick(20);
        await sendKeys(app.stdin, "\x1b[B");
        await sendKeys(app.stdin, "c");
        await sendKeys(app.stdin, "\r");
        const close = lastWorkspaceCall("close");
        expect(close.options.force).toBeUndefined();

        // Switching away and back must not restore the old prompt's ownership.
        for (let index = 0; index < 3; index += 1) {
          if (input === "keyboard") await sendKeys(app.stdin, "g");
          else {
            const header = app.lines()[0] ?? "";
            const label = header.includes("[Agents]")
              ? "[Agents]"
              : "[Worktrees]";
            await sendKeys(app.stdin, sgrPress(header.indexOf(label) + 1, 1));
          }
        }
        expect(app.lines()[0]).toContain("[Worktrees]");
        const worktreePath = join(root, "alpha", "alpha-branch");
        close.resolve({
          operation: "close",
          worktreePath,
          sessionName: "alpha-branch",
          existed: true,
          status: "blocked_by_changes",
          attempts: {
            down: { attempted: false, reason: "down_not_configured" },
            kill: { attempted: true, ok: true, value: null },
            remove: {
              attempted: true,
              ok: true,
              value: { _tag: "BlockedByChanges", path: worktreePath },
            },
          },
          warnings: [],
        } satisfies WorkspaceCloseResult);
        await tick(20);
        expect(app.lines().join("\n")).not.toContain("Force Close Worktree");
        expect(app.lines().join("\n")).toContain("uncommitted changes");
        await sendKeys(app.stdin, "\r");
        expect(workspaceCalls("close")).toHaveLength(1);
        expect(tmuxFixtures.switchCalls.at(-1)?.target).toBe("%1");
      } finally {
        app.unmount();
      }
    },
  );

  test("header hit targets and both agent lines support mouse input; modals suspend the view", async () => {
    const app = await renderApp(<App />);
    try {
      await tick(20);
      await sendKeys(
        app.stdin,
        sgrPress((app.lines()[0] ?? "").indexOf("[Agents]") + 1, 1),
      );
      const statusRow =
        app.lines().findIndex((line) => line.includes("blocked · codex")) + 1;
      await sendKeys(app.stdin, sgrPress(8, statusRow));
      expect(selectedLine(app.lines())).toContain("Fix navigation");
      await sendKeys(app.stdin, sgrPress(8, statusRow));
      expect(tmuxFixtures.switchCalls.map((call) => call.target)).toEqual([
        "%2",
      ]);
      await sendKeys(app.stdin, sgrPress(100, 1));
      expect(app.lines().join("\n")).toContain("Add Project");
      await sendKeys(app.stdin, "g");
      await sendKeys(app.stdin, "\r");
      expect(tmuxFixtures.switchCalls).toHaveLength(1);
      await sendKeys(app.stdin, "\x1b");
      await tick(30);
      expect(app.lines()[0]).toContain("[Worktrees]");
      await sendKeys(
        app.stdin,
        sgrPress((app.lines()[0] ?? "").indexOf("[Worktrees]") + 1, 1),
      );
      expect(app.lines()[0]).toContain("[Agents]");
    } finally {
      app.unmount();
    }
  });

  test.each([17, 18, 19, 20])(
    "keeps header and agent mouse targets aligned after resizing to %i columns",
    async (columns) => {
      const app = await renderApp(<App />, 16, 32);
      try {
        await tick(20);
        app.stdout.columns = columns;
        app.stdout.emit("resize");
        await tick(5);
        const worktreesHeader = app.lines()[0] ?? "";
        expect(worktreesHeader).toContain("[Agents]");
        expect(worktreesHeader.length).toBeLessThanOrEqual(columns);
        expect(app.lines()[1]?.trim()).toBe("");
        expect(app.lines()[2]).toContain("alpha");
        await sendKeys(
          app.stdin,
          sgrPress(worktreesHeader.indexOf("[Agents]") + 1, 1),
        );
        const agentsHeader = app.lines()[0] ?? "";
        expect(agentsHeader).toMatch(/\[(?:Worktrees|W)\]/);
        expect(agentsHeader.length).toBeLessThanOrEqual(columns);
        expect(app.lines()[1]?.trim()).toBe("");
        expect(app.lines()[2]?.trim()).toBe("alpha");

        // Exercise both lines of adjacent agents at their physical terminal rows.
        for (const [row, paneId] of [
          [4, "%1"],
          [5, "%1"],
          [6, "%2"],
          [7, "%2"],
        ] as const) {
          await sendKeys(app.stdin, sgrPress(5, row));
          await sendKeys(app.stdin, "\r");
          expect(tmuxFixtures.switchCalls.at(-1)?.target).toBe(paneId);
        }

        const addColumn = agentsHeader.indexOf("[+]") + 1;
        expect(addColumn).toBeGreaterThan(0);
        await sendKeys(app.stdin, sgrPress(addColumn - 1, 1));
        expect(app.lines().join("\n")).not.toContain("Add Project");
        await sendKeys(app.stdin, sgrPress(addColumn, 1));
        expect(app.lines().join("\n")).toContain("Add Project");
        await sendKeys(app.stdin, "\x1b");
        await tick(30);
        const viewLabel = agentsHeader.includes("[Worktrees]")
          ? "[Worktrees]"
          : "[W]";
        await sendKeys(
          app.stdin,
          sgrPress(agentsHeader.indexOf(viewLabel) + 1, 1),
        );
        expect(app.lines()[0]).toContain("[Agents]");
        expect(app.lines()[2]).toContain("alpha");
      } finally {
        app.unmount();
      }
    },
  );

  test("selection follows its pane on refresh and empty projects disappear", async () => {
    const app = await renderApp(<App />);
    try {
      await tick(20);
      await sendKeys(app.stdin, "g");
      await sendKeys(app.stdin, "\x1b[B");
      fixtures.snapshot = {
        ...fixtures.snapshot,
        observations: new Map([
          ["%2", { ...observation("%2", "unknown"), freshness: "unavailable" }],
          ["%3", observation("%3", "idle")],
        ]),
      };
      tmuxFixtures.panes.set("alpha-branch", [pane("%2", "Renamed task")]);
      await triggerRefresh();
      await tick(10);
      expect(selectedLine(app.lines())).toContain("Renamed task");
      expect(app.lines().join("\n")).toContain("unknown · codex (unavailable)");
      await sendKeys(app.stdin, "\r");
      expect(tmuxFixtures.switchCalls.at(-1)?.target).toBe("%2");
      fixtures.snapshot = {
        observations: new Map(),
        memberships: new Map(),
        summaries: new Map(),
      };
      await triggerRefresh();
      await tick(10);
      expect(app.lines().join("\n")).toContain("No running agents");
      expect(app.lines().join("\n")).not.toContain("alpha");
      await sendKeys(app.stdin, "\r");
      expect(tmuxFixtures.switchCalls).toHaveLength(1);
    } finally {
      app.unmount();
    }
  });

  test.each(["exits", "is replaced"] as const)(
    "clears selection when the selected agent %s until explicit reselection",
    async (change) => {
      const app = await renderApp(<App />);
      try {
        await tick(20);
        await sendKeys(app.stdin, "g");
        await sendKeys(app.stdin, "\x1b[B");
        expect(selectedLine(app.lines())).toContain("Fix navigation");
        const observations = new Map(fixtures.snapshot.observations);
        if (change === "exits") observations.delete("%2");
        else
          observations.set("%2", {
            ...observation("%2"),
            generation: "replacement",
          });
        fixtures.snapshot = { ...fixtures.snapshot, observations };
        await triggerRefresh();
        await tick(10);
        expect(selectedLine(app.lines())).toBeUndefined();
        for (const key of ["\r", " ", "x"]) await sendKeys(app.stdin, key);
        expect(tmuxFixtures.switchCalls).toHaveLength(0);
        expect(tmuxFixtures.killCalls).toHaveLength(0);
        expect(app.lines().join("\n")).not.toContain("Kill Pane");
        await triggerRefresh();
        await tick(10);
        expect(selectedLine(app.lines())).toBeUndefined();

        await sendKeys(app.stdin, "\x1b[B");
        expect(selectedLine(app.lines())).toContain(
          "Add agents view toggle | wct",
        );
        await sendKeys(app.stdin, "\r");
        expect(tmuxFixtures.switchCalls.at(-1)?.target).toBe("%1");

        const title = change === "exits" ? "Review changes" : "Fix navigation";
        const row = app.lines().findIndex((line) => line.includes(title));
        expect(row).toBeGreaterThanOrEqual(0);
        await sendKeys(app.stdin, sgrPress(8, row + 1));
        expect(selectedLine(app.lines())).toContain(title);
        await sendKeys(app.stdin, "x");
        expect(app.lines().join("\n")).toContain("Kill Pane");
        await sendKeys(app.stdin, "\r");
        expect(tmuxFixtures.killCalls).toEqual([
          change === "exits" ? "%3" : "%2",
        ]);
      } finally {
        app.unmount();
      }
    },
  );

  test("selects initial arrivals but keeps a cleared selection empty when agents return", async () => {
    const populated = fixtures.snapshot;
    const empty: WorkspaceAgentSnapshot = {
      observations: new Map(),
      memberships: new Map(),
      summaries: new Map(),
    };
    fixtures.snapshot = empty;
    const app = await renderApp(<App />);
    try {
      await tick(20);
      await sendKeys(app.stdin, "g");
      fixtures.snapshot = populated;
      await triggerRefresh();
      await tick(10);
      expect(selectedLine(app.lines())).toContain(
        "Add agents view toggle | wct",
      );
      fixtures.snapshot = empty;
      await triggerRefresh();
      await tick(10);
      expect(selectedLine(app.lines())).toBeUndefined();
      fixtures.snapshot = populated;
      await triggerRefresh();
      await tick(10);
      expect(selectedLine(app.lines())).toBeUndefined();
      for (const key of ["\r", " ", "x"]) await sendKeys(app.stdin, key);
      expect(tmuxFixtures.switchCalls).toHaveLength(0);
      expect(tmuxFixtures.killCalls).toHaveLength(0);
      expect(app.lines().join("\n")).not.toContain("Kill Pane");
    } finally {
      app.unmount();
    }
  });

  test("x confirms the selected agent pane, supports cancel, and returns to agents after killing", async () => {
    const app = await renderApp(<App />);
    tmuxFixtures.onKill = async (paneId) => {
      fixtures.snapshot = {
        ...fixtures.snapshot,
        observations: new Map(
          [...fixtures.snapshot.observations].filter(([id]) => id !== paneId),
        ),
      };
    };
    try {
      await tick(20);
      await sendKeys(app.stdin, "g");
      await sendKeys(app.stdin, "\x1b[B");
      await sendKeys(app.stdin, "x");
      expect(app.lines().join("\n")).toContain(
        "Kill pane alpha-branch · Fix navigation?",
      );
      const frame = app.lines();
      const confirmation = frame.findIndex((line) =>
        line.includes("Kill Pane"),
      );
      const agentStatus = frame.findIndex((line) =>
        line.includes("blocked · codex"),
      );
      const nextProject = frame.findIndex((line) => line.trim() === "beta");
      expect(confirmation).toBe(agentStatus + 1);
      expect(nextProject).toBeGreaterThan(confirmation);
      expect(tmuxFixtures.killCalls).toHaveLength(0);
      await sendKeys(app.stdin, "g");
      await sendKeys(app.stdin, "\x1b[B");
      expect(app.lines().join("\n")).toContain("Kill Pane");
      expect(tmuxFixtures.switchCalls).toHaveLength(0);
      await sendKeys(app.stdin, "\x1b");
      await tick(30);
      expect(app.lines().join("\n")).not.toContain("Kill Pane");
      expect(selectedLine(app.lines())).toContain("Fix navigation");
      expect(tmuxFixtures.killCalls).toHaveLength(0);
      await sendKeys(app.stdin, "x");
      await sendKeys(app.stdin, "\r");
      expect(tmuxFixtures.killCalls).toEqual(["%2"]);
      expect(app.lines().join("\n")).not.toContain("Kill Pane");
      expect(app.lines()[0]).toContain("[Worktrees]");
      expect(app.lines().join("\n")).not.toContain("Fix navigation");
      expect(workspaceCalls()).toHaveLength(0);
    } finally {
      app.unmount();
    }
  });

  test("linked-pane confirmation stays below the selected project's occurrence across refreshes", async () => {
    fixtures.snapshot = {
      observations: new Map([["%1", observation("%1")]]),
      memberships: new Map([
        ["alpha-branch", new Set(["%1"])],
        ["beta-branch", new Set(["%1"])],
      ]),
      summaries: new Map(),
    };
    for (const session of ["alpha-branch", "beta-branch"]) {
      tmuxFixtures.panes.set(session, [pane("%1", "Shared agent")]);
    }
    tmuxFixtures.onKill = async () => {
      fixtures.snapshot = { ...fixtures.snapshot, observations: new Map() };
    };
    const app = await renderApp(<App />);
    const expectConfirmationUnderBeta = () => {
      const frame = app.lines();
      const agent = frame.findIndex((line) => line.includes("● beta-branch"));
      const confirmation = frame.findIndex((line) =>
        line.includes("Kill Pane"),
      );
      expect(agent).toBeGreaterThanOrEqual(0);
      expect(confirmation).toBe(agent + 2);
      expect(frame.join("\n")).toContain(
        "Kill pane beta-branch · Shared agent?",
      );
    };
    try {
      await tick(20);
      await sendKeys(app.stdin, "g");
      await sendKeys(app.stdin, "\x1b[B");
      expect(selectedLine(app.lines())).toContain("beta-branch");
      await sendKeys(app.stdin, "x");
      expectConfirmationUnderBeta();
      expect(tmuxFixtures.killCalls).toHaveLength(0);

      registryItems.items = registryItems.items.toReversed();
      await triggerRefresh();
      await tick(10);
      expectConfirmationUnderBeta();
      await sendKeys(app.stdin, "\x1b");
      await tick(30);
      expect(app.lines().join("\n")).not.toContain("Kill Pane");
      expect(selectedLine(app.lines())).toContain("beta-branch");
      expect(tmuxFixtures.killCalls).toHaveLength(0);

      await sendKeys(app.stdin, "x");
      expectConfirmationUnderBeta();
      await sendKeys(app.stdin, "\r");
      expect(tmuxFixtures.killCalls).toEqual(["%1"]);
      expect(app.lines().join("\n")).toContain("No running agents");
      expect(workspaceCalls()).toHaveLength(0);
    } finally {
      app.unmount();
    }
  });

  test.each(["exits", "is replaced"] as const)(
    "kill confirmation closes if the target agent %s",
    async (change) => {
      const app = await renderApp(<App />);
      try {
        await tick(20);
        await sendKeys(app.stdin, "g");
        await sendKeys(app.stdin, "x");
        expect(app.lines().join("\n")).toContain("Kill Pane");
        const observations = new Map(fixtures.snapshot.observations);
        if (change === "exits") observations.delete("%1");
        else
          observations.set("%1", {
            ...observation("%1"),
            generation: "replacement",
          });
        fixtures.snapshot = { ...fixtures.snapshot, observations };
        await triggerRefresh();
        await tick(10);
        expect(app.lines().join("\n")).not.toContain("Kill Pane");
        expect(tmuxFixtures.killCalls).toHaveLength(0);
      } finally {
        app.unmount();
      }
    },
  );

  test("agent kill confirmation supports mouse cancel and confirm in a short viewport", async () => {
    const app = await renderApp(<App />, 14, 32);
    const clickLabel = async (label: string) => {
      const row = app.lines().findIndex((line) => line.includes(label));
      expect(row).toBeGreaterThanOrEqual(0);
      await sendKeys(
        app.stdin,
        sgrPress((app.lines()[row] ?? "").indexOf(label) + 1, row + 1),
      );
    };
    try {
      await tick(20);
      await sendKeys(app.stdin, "g");
      await sendKeys(app.stdin, "\x1b[B");
      await sendKeys(app.stdin, "x");
      expect(
        app.lines().filter((line) => line.trim()).length,
      ).toBeLessThanOrEqual(14);
      await clickLabel("esc:cancel");
      expect(tmuxFixtures.killCalls).toHaveLength(0);
      expect(app.lines().join("\n")).not.toContain("Kill Pane");
      await sendKeys(app.stdin, "x");
      await clickLabel("enter:confirm");
      expect(tmuxFixtures.killCalls).toEqual(["%2"]);
      expect(tmuxFixtures.switchCalls).toHaveLength(0);
      expect(app.lines().join("\n")).not.toContain("Kill Pane");
    } finally {
      app.unmount();
    }
  });

  test.each([8, 12])(
    "long kill questions keep mouse actions visible at 32×8 (initial height %i)",
    async (initialRows) => {
      tmuxFixtures.panes.set("alpha-branch", [
        pane("%1", `Review ${"x".repeat(100)}`),
        pane("%2", "Fix navigation"),
      ]);
      const app = await renderApp(<App />, initialRows, 32);
      const clickAction = async (label: string) => {
        const frame = app.lines();
        const row = frame.findIndex((line) => line.includes(label));
        expect(row).toBeGreaterThanOrEqual(2);
        expect(row).toBeLessThan(8);
        await sendKeys(
          app.stdin,
          sgrPress((frame[row] ?? "").indexOf(label) + 1, row + 1),
        );
      };
      try {
        await tick(20);
        await sendKeys(app.stdin, "g");
        const before = app.lines();
        await sendKeys(app.stdin, "x");
        if (initialRows !== 8) {
          app.stdout.rows = 8;
          app.stdout.emit("resize");
          await tick(5);
        }
        const frame = app.lines();
        expect(frame.join("\n")).toContain("Kill pane alpha-branch");
        expect(frame.join("\n")).toContain("Review …");
        expect(frame.join("\n")).toContain("enter:confirm");
        expect(frame.join("\n")).toContain("esc:cancel");
        expect(frame.slice(8).every((line) => !line.trim())).toBe(true);
        await clickAction("esc:cancel");
        expect(tmuxFixtures.killCalls).toHaveLength(0);
        expect(app.lines().join("\n")).not.toContain("Kill Pane");
        expect(app.lines().join("\n")).toContain("alpha-branch");
        if (initialRows === 8) expect(app.lines()).toEqual(before);
        await sendKeys(app.stdin, "x");
        await clickAction("enter:confirm");
        expect(tmuxFixtures.killCalls).toEqual(["%1"]);
        expect(app.lines().join("\n")).not.toContain("Kill Pane");
      } finally {
        app.unmount();
      }
    },
  );

  test("a pending kill keeps its confirmation and ignores duplicate submissions; failures allow retry", async () => {
    let finishKill: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finishKill = resolve;
    });
    tmuxFixtures.onKill = () => pending;
    const app = await renderApp(<App />);
    try {
      await tick(20);
      await sendKeys(app.stdin, "g");
      await sendKeys(app.stdin, "x");
      await sendKeys(app.stdin, "\r");
      await sendKeys(app.stdin, "\r");
      await sendKeys(app.stdin, "\x1b");
      await tick(30);
      expect(tmuxFixtures.killCalls).toEqual(["%1"]);
      expect(app.lines().join("\n")).toContain("Kill Pane");
      finishKill?.();
      await tick(10);
      expect(app.lines().join("\n")).not.toContain("Kill Pane");

      tmuxFixtures.onKill = async () => {
        throw new Error("tmux unavailable");
      };
      await sendKeys(app.stdin, "x");
      await sendKeys(app.stdin, "\r");
      expect(app.lines().join("\n")).toContain("Failed to kill pane");
      expect(app.lines().join("\n")).toContain("Kill Pane");
      tmuxFixtures.onKill = null;
      await sendKeys(app.stdin, "\r");
      expect(tmuxFixtures.killCalls).toEqual(["%1", "%1", "%1"]);
      expect(app.lines().join("\n")).not.toContain("Kill Pane");
    } finally {
      finishKill?.();
      app.unmount();
    }
  });

  test.each(["exits", "is replaced"] as const)(
    "a failed pending kill dismisses confirmation when its target %s",
    async (change) => {
      let rejectKill: ((error: Error) => void) | undefined;
      const pending = new Promise<void>((_resolve, reject) => {
        rejectKill = reject;
      });
      pending.catch(() => {});
      tmuxFixtures.onKill = () => pending;
      const app = await renderApp(<App />);
      try {
        await tick(20);
        await sendKeys(app.stdin, "g");
        await sendKeys(app.stdin, "x");
        await sendKeys(app.stdin, "\r");
        expect(tmuxFixtures.killCalls).toEqual(["%1"]);
        const observations = new Map(fixtures.snapshot.observations);
        if (change === "exits") observations.delete("%1");
        else
          observations.set("%1", {
            ...observation("%1"),
            generation: "replacement",
          });
        fixtures.snapshot = { ...fixtures.snapshot, observations };
        await triggerRefresh();
        await tick(10);
        expect(app.lines().join("\n")).toContain("Kill Pane");

        rejectKill?.(new Error("tmux unavailable"));
        await tick(10);
        expect(app.lines().join("\n")).toContain("Failed to kill pane");
        expect(app.lines().join("\n")).not.toContain("Kill Pane");
        await sendKeys(app.stdin, "\r");
        expect(tmuxFixtures.killCalls).toEqual(["%1"]);
        expect(tmuxFixtures.switchCalls).toHaveLength(0);
        expect(selectedLine(app.lines())).toBeUndefined();
        await sendKeys(app.stdin, "\x1b[B");
        await sendKeys(app.stdin, "\r");
        expect(tmuxFixtures.switchCalls.at(-1)?.target).toBe(
          change === "exits" ? "%2" : "%1",
        );
      } finally {
        rejectKill?.(new Error("test cleanup"));
        app.unmount();
      }
    },
  );

  test("keyboard reveals offscreen agents and wheel scrolling preserves the target", async () => {
    tmuxFixtures.panes.set(
      "alpha-branch",
      Array.from({ length: 12 }, (_, i) => pane(`%${i}`, `Task ${i}`)),
    );
    fixtures.snapshot = {
      observations: new Map(
        Array.from({ length: 12 }, (_, i) => [`%${i}`, observation(`%${i}`)]),
      ),
      memberships: new Map([
        [
          "alpha-branch",
          new Set(Array.from({ length: 12 }, (_, i) => `%${i}`)),
        ],
      ]),
      summaries: new Map(),
    };
    const app = await renderApp(<App />, 8, 32);
    try {
      await tick(20);
      await sendKeys(app.stdin, "g");
      await sendKeys(app.stdin, "\x1b[F");
      expect(selectedLine(app.lines())).toContain("Task 11");
      expect(app.lines().length).toBeLessThanOrEqual(9);
      await sendKeys(app.stdin, "\x1b[<64;5;4M");
      await sendKeys(app.stdin, "\r");
      expect(tmuxFixtures.switchCalls.at(-1)?.target).toBe("%11");
      await sendKeys(app.stdin, "\x1b[H");
      expect(selectedLine(app.lines())).toContain("Task 0");
    } finally {
      app.unmount();
    }
  });

  test("inline kill confirmation scrolls into view and cancel restores the previous agent viewport", async () => {
    tmuxFixtures.panes.set(
      "alpha-branch",
      Array.from({ length: 12 }, (_, i) => pane(`%${i}`, `Task ${i}`)),
    );
    fixtures.snapshot = {
      observations: new Map(
        Array.from({ length: 12 }, (_, i) => [`%${i}`, observation(`%${i}`)]),
      ),
      memberships: new Map([
        [
          "alpha-branch",
          new Set(Array.from({ length: 12 }, (_, i) => `%${i}`)),
        ],
      ]),
      summaries: new Map(),
    };
    const app = await renderApp(<App />, 10, 32);
    try {
      await tick(20);
      await sendKeys(app.stdin, "g");
      await sendKeys(app.stdin, "\x1b[F");
      const before = app.lines();
      await sendKeys(app.stdin, "x");
      const frame = app.lines();
      const confirmation = frame.findIndex((line) =>
        line.includes("Kill Pane"),
      );
      const target = frame.findIndex(
        (line) => line.includes("Task 11") && !line.includes("Kill pane"),
      );
      expect(target).toBeGreaterThanOrEqual(2);
      expect(confirmation).toBe(target + 2);
      expect(frame.join("\n")).toContain("enter:confirm");
      expect(frame.join("\n")).toContain("esc:cancel");
      expect(frame.slice(10).every((line) => !line.trim())).toBe(true);
      await sendKeys(app.stdin, "\x1b");
      await tick(30);
      expect(app.lines()).toEqual(before);
      expect(tmuxFixtures.killCalls).toHaveLength(0);
      await sendKeys(app.stdin, "\r");
      expect(tmuxFixtures.switchCalls.at(-1)?.target).toBe("%11");
    } finally {
      app.unmount();
    }
  });

  test("reports a missing tmux client when jumping", async () => {
    tmuxFixtures.clients = [];
    tmuxFixtures.panes.clear();
    const app = await renderApp(<App />);
    try {
      await tick(20);
      await sendKeys(app.stdin, "g");
      expect(selectedLine(app.lines())).toContain("alpha-branch");
      expect(selectedLine(app.lines())).not.toContain("%1");
      await sendKeys(app.stdin, "\r");
      expect(tmuxFixtures.switchCalls).toHaveLength(0);
      expect(app.lines().join("\n")).toContain("No tmux client selected");
    } finally {
      app.unmount();
    }
  });
});

test("agent grouping deduplicates linked panes per project and keeps duplicate project names distinct", () => {
  const repo: RepoInfo = {
    id: RegistrationId("a"),
    project: "same-name",
    repoPath: "/a",
    profileNames: [],
    worktrees: ["one", "two"].map((branch) => ({
      branch,
      path: `/a/${branch}`,
      isMainWorktree: false,
      changedFiles: 0,
      sync: null,
    })),
  };
  const list = buildAgentList(
    [repo, { ...repo, id: RegistrationId("b"), repoPath: "/b" }],
    {
      observations: new Map([
        ["%1", observation("%1")],
        ["%outside", observation("%outside")],
      ]),
      memberships: new Map([
        ["one", new Set(["%1", "%shell"])],
        ["two", new Set(["%1"])],
      ]),
    },
    new Map([["one", [pane("%1", " Task\nname ")]]]),
  );
  expect(list.items.map((item) => item.paneId)).toEqual(["%1", "%1"]);
  expect(list.items.map((item) => item.title)).toEqual([
    "Task name",
    "Task name",
  ]);
  expect(new Set(list.items.map((item) => item.id)).size).toBe(2);
  expect(
    list.rows.filter((row) => row.kind === "project").map((row) => row.id),
  ).toEqual(["/a", "/b"]);
});

// Lifecycle tests for `close`. The "rendered progress rows" tests drive the
// REAL App through Ink's input pipeline (`c` → confirm → enter) and assert on
// rendered frames; the rest drive `createExecuteClose` directly, because the
// phase ORDER around validation, teardown and the force hand-off is what
// those tests are about, and a rendered frame cannot observe a transition
// that React coalesces.
//
// Both halves share `./app-harness`: its deferred `WorkspaceService.close` lets
// a close be observed mid-flight, and its `vi.mock` registrations must run
// before the modules under test are loaded — hence the dynamic imports.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkspaceCloseResult } from "../../src/services/workspace-service";
import type { SessionActionDeps } from "../../src/tui/hooks/useSessionActions";
import type {
  LifecycleEntry,
  LifecyclePhase,
  LifecycleState,
} from "../../src/tui/lifecycle";
import {
  createLifecycleClaims,
  lifecycleKey,
  lifecyclePhaseLabel,
} from "../../src/tui/lifecycle";
import { isWorktreeEffectivelyExpanded } from "../../src/tui/tree-helpers";
import { Mode, pendingKey } from "../../src/tui/types";
import {
  emitWorkspacePhase,
  githubFixtures,
  lastWorkspaceCall,
  makeWorktree,
  registryItems,
  renderApp,
  resetHarnessFixtures,
  selectedLine,
  sendKeys,
  tick,
  triggerRefresh,
  worktreeFixtures,
} from "./app-harness";

const ENTER = "\r";
const ESCAPE = "\x1b";
const ARROW_DOWN = "\x1b[B";
const ARROW_RIGHT = "\x1b[C";

const REPO_PATH = "/repo";
const BRANCH = "feat";
const PROJECT = "proj";
const WORKTREE_PATH = "/repo/feat";
const WORKTREE_KEY = pendingKey(PROJECT, BRANCH);

/** A live `setLifecycle` stand-in: applies updates exactly as React would. */
function trackLifecycle() {
  const tracker = {
    state: new Map() as LifecycleState,
    phases: [] as Array<LifecyclePhase | null>,
    setLifecycle: (
      update: LifecycleState | ((prev: LifecycleState) => LifecycleState),
    ) => {
      const next =
        typeof update === "function" ? update(tracker.state) : update;
      // React bails out when an updater returns the identical state, so a
      // second teardown from a `finally` is not a render — and not a row.
      if (next === tracker.state) return tracker.state;
      tracker.state = next;
      tracker.phases.push(tracker.entry()?.phase ?? null);
      return tracker.state;
    },
    entry: (): LifecycleEntry | undefined =>
      tracker.state.get(lifecycleKey(REPO_PATH, BRANCH)),
    labels: () =>
      tracker.phases.map((phase) =>
        phase ? lifecyclePhaseLabel(phase) : null,
      ),
  };
  return tracker;
}

function makeDeps(overrides: Partial<SessionActionDeps> = {}) {
  return {
    treeItems: [],
    filteredRepos: [],
    sessions: [],
    selectedIndex: 0,
    mode: Mode.Navigate,
    lifecycle: new Map(),
    lifecycleClaims: createLifecycleClaims(),
    setSelectedIndex: vi.fn(),
    setMode: vi.fn(),
    modeRef: { current: Mode.Navigate },
    setLifecycle: vi.fn(),
    showActionError: vi.fn(),
    clearActionError: vi.fn(),
    switchSession: vi.fn().mockResolvedValue(true),
    detachClient: vi.fn().mockResolvedValue(true),
    discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
    refreshSessions: vi.fn().mockResolvedValue([]),
    refreshAll: vi.fn().mockResolvedValue([]),
    restoreConfirmationViewport: vi.fn(),
    confirmDownReturnModeRef: { current: Mode.Navigate },
    confirmDownReturnSelectedIndexRef: { current: 0 },
    confirmCloseReturnModeRef: { current: Mode.Navigate },
    confirmCloseReturnSelectedIndexRef: { current: 0 },
    ...overrides,
  } satisfies SessionActionDeps;
}

function makeCloseResult(
  overrides: Partial<WorkspaceCloseResult> = {},
): WorkspaceCloseResult {
  return {
    operation: "close",
    worktreePath: WORKTREE_PATH,
    sessionName: "feat",
    existed: true,
    status: "removed",
    attempts: {
      kill: { attempted: true, ok: true, value: null },
      remove: {
        attempted: true,
        ok: true,
        value: { _tag: "Removed", path: WORKTREE_PATH },
      },
    },
    warnings: [],
    ...overrides,
  };
}

const blockedResult = () =>
  makeCloseResult({
    status: "blocked_by_changes",
    attempts: {
      kill: { attempted: true, ok: true, value: null },
      remove: {
        attempted: true,
        ok: true,
        value: { _tag: "BlockedByChanges", path: WORKTREE_PATH },
      },
    },
  });

/**
 * Start a close and stop as soon as the service call is in flight, so the test
 * owns every phase event and the moment the call settles.
 */
async function startClose(
  deps: SessionActionDeps,
  force = false,
): Promise<{
  settled: Promise<void>;
  call: ReturnType<typeof lastWorkspaceCall>;
}> {
  const { createExecuteClose } = await import(
    "../../src/tui/hooks/useSessionActions"
  );
  const settled = createExecuteClose(deps)(
    "feat",
    BRANCH,
    WORKTREE_PATH,
    WORKTREE_KEY,
    REPO_PATH,
    PROJECT,
    force,
  );
  await tick(2);
  return { settled, call: lastWorkspaceCall("close") };
}

describe("TUI close lifecycle", () => {
  beforeEach(() => {
    resetHarnessFixtures();
  });

  describe("rendered progress rows", () => {
    let homeDir: string;
    let repoPath: string;

    beforeEach(() => {
      homeDir = mkdtempSync(join(tmpdir(), "wct-app-close-home-"));
      repoPath = mkdtempSync(join(tmpdir(), "wct-app-close-repo-"));
      mkdirSync(join(homeDir, ".wct"), { recursive: true });
      vi.stubEnv("HOME", homeDir);
      worktreeFixtures.byRepoPath.set(repoPath, [
        makeWorktree(repoPath, "main"),
        makeWorktree(repoPath, "feature/x"),
      ]);
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(repoPath, { recursive: true, force: true });
    });

    // At the App level: the helper is unit-tested, but only a rendered
    // App proves the wiring — `prevSelectionParentIdRef` and the `lifecycle`
    // the fallback is scoped to are both passed by App.tsx, and dropping either
    // argument leaves the cursor on whatever row inherited the index.
    test("moves the cursor to the branch row when a lifecycle suppresses the selected detail row", async () => {
      // A branch AFTER feature/x, so the index the vanished detail row leaves
      // behind is a DIFFERENT Workspace: the plain clamp would land there.
      worktreeFixtures.byRepoPath.set(repoPath, [
        makeWorktree(repoPath, "main"),
        makeWorktree(repoPath, "feature/x"),
        makeWorktree(repoPath, "feature/y"),
      ]);
      githubFixtures.prsByRepoPath.set(repoPath, [
        {
          number: 42,
          title: "Add x",
          state: "OPEN",
          headRefName: "feature/x",
          rollupState: null,
        },
      ]);

      const { App } = await import("../../src/tui/App");
      const app = await renderApp(<App />);
      await tick(6);

      // repo row → main → feature/x, then fetch PRs and expand it so the
      // Workspace really has a detail row to select.
      await sendKeys(app.stdin, ARROW_DOWN);
      await sendKeys(app.stdin, ARROW_DOWN);
      expect(selectedLine(app.lines())).toContain("feature/x");
      await sendKeys(app.stdin, "r");
      await tick(6);
      await sendKeys(app.stdin, ARROW_RIGHT);
      await tick(4);
      await sendKeys(app.stdin, ARROW_DOWN);
      await tick(2);
      expect(selectedLine(app.lines())).toContain("#42");

      // The close claims the Workspace, which suppresses its detail rows.
      await sendKeys(app.stdin, "c");
      await sendKeys(app.stdin, ENTER);
      await tick(8);

      const frame = app.lines();
      expect(frame.join("\n")).toContain("Preparing Workspace…");
      expect(frame.join("\n")).not.toContain("#42");
      // The cursor followed the Workspace instead of staying at the index
      // feature/y inherited.
      expect(selectedLine(frame)).toContain("feature/x");
      expect(selectedLine(frame)).not.toContain("feature/y");

      app.unmount();
    });

    test("shows Preparing, then Killing tmux session only when a kill runs, then Removing worktree before removal", async () => {
      const { App } = await import("../../src/tui/App");
      const app = await renderApp(<App />);
      await tick(6);

      // repo row → main → feature/x
      await sendKeys(app.stdin, ARROW_DOWN);
      await sendKeys(app.stdin, ARROW_DOWN);
      expect(selectedLine(app.lines())).toContain("feature/x");

      await sendKeys(app.stdin, "c");
      expect(app.lines().join("\n")).toContain("Close worktree feature/x?");
      await sendKeys(app.stdin, ENTER);
      await tick(8);

      // The close is in flight and the Workspace says what it is doing.
      expect(app.lines().join("\n")).toContain("Preparing Workspace…");
      const call = lastWorkspaceCall("close");
      expect(call.options.path).toBe(join(repoPath, "feature-x"));
      expect(call.options.cwd).toBe(repoPath);

      // Session teardown is its own phase.
      emitWorkspacePhase(call, { _tag: "KillingTmuxSession" });
      await tick(3);
      expect(app.lines().join("\n")).toContain("Killing tmux session…");

      // Filesystem teardown is a DIFFERENT phase, and it is on screen while
      // the service call is still in flight — i.e. before removal completes.
      emitWorkspacePhase(call, { _tag: "RemovingWorktree" });
      await tick(3);
      const midFlight = app.lines().join("\n");
      expect(midFlight).toContain("Removing worktree…");
      // At most one progress row per Workspace: the kill row is replaced.
      expect(midFlight).not.toContain("Killing tmux session…");
      expect(midFlight).toContain("feature/x");

      // The removal lands; the tree is refreshed by validation.
      worktreeFixtures.byRepoPath.set(repoPath, [
        makeWorktree(repoPath, "main"),
      ]);
      call.resolve({
        operation: "close",
        worktreePath: join(repoPath, "feature-x"),
        sessionName: "feature-x",
        existed: true,
        status: "removed",
        attempts: {
          kill: { attempted: true, ok: true, value: null },
          remove: {
            attempted: true,
            ok: true,
            value: { _tag: "Removed", path: join(repoPath, "feature-x") },
          },
        },
        warnings: [],
      });
      await tick(14);

      const after = app.lines().join("\n");
      expect(after).not.toContain("feature/x");
      expect(after).not.toContain("Removing worktree…");
      expect(after).not.toContain("Validating Workspace…");
      app.unmount();

      // --- No session to kill: nothing emits the kill phase, so no such row
      // is ever painted for the whole operation.
      worktreeFixtures.byRepoPath.set(repoPath, [
        makeWorktree(repoPath, "main"),
        makeWorktree(repoPath, "feature/x"),
      ]);
      const second = await renderApp(<App />);
      await tick(6);
      await sendKeys(second.stdin, ARROW_DOWN);
      await sendKeys(second.stdin, ARROW_DOWN);
      await sendKeys(second.stdin, "c");
      await sendKeys(second.stdin, ENTER);
      await tick(8);
      expect(second.lines().join("\n")).toContain("Preparing Workspace…");

      const skipKill = lastWorkspaceCall("close");
      emitWorkspacePhase(skipKill, { _tag: "RemovingWorktree" });
      await tick(3);
      expect(second.lines().join("\n")).toContain("Removing worktree…");
      expect(second.output()).not.toContain("Killing tmux session…");
      second.unmount();
    });

    test("presents forced expansion across a mid-operation poll and writes no stored preference", async () => {
      const { App } = await import("../../src/tui/App");
      const app = await renderApp(<App />);
      await tick(6);

      const workspaceLine = () =>
        app.lines().find((line) => line.includes("feature/x")) ?? "";

      // repo row → main → feature/x. The user has expanded nothing, so no
      // Workspace is presented as expanded.
      await sendKeys(app.stdin, ARROW_DOWN);
      await sendKeys(app.stdin, ARROW_DOWN);
      expect(selectedLine(app.lines())).toContain("feature/x");
      expect(workspaceLine()).not.toContain("▼");

      await sendKeys(app.stdin, "c");
      await sendKeys(app.stdin, ENTER);
      await tick(8);
      const call = lastWorkspaceCall("close");
      emitWorkspacePhase(call, { _tag: "RemovingWorktree" });
      await tick(3);
      expect(app.lines().join("\n")).toContain("Removing worktree…");
      // Mid-lifecycle the Workspace IS presented as expanded…
      expect(workspaceLine()).toContain("▼");

      // …and a registry poll landing mid-operation — which reconciles (prunes)
      // the stored preference on every `repos` change — cannot disturb it,
      // precisely because the expansion was never stored.
      await triggerRefresh();
      await tick(6);
      expect(workspaceLine()).toContain("▼");
      expect(app.lines().join("\n")).toContain("Removing worktree…");

      // The close is refused, so the Workspace survives validation — and with
      // the lifecycle entry gone it is back to the user's own preference:
      // collapsed. Nothing was written, so there is nothing to restore.
      call.reject(new Error("worktree busy"));
      await tick(14);
      expect(workspaceLine()).toContain("feature/x");
      expect(workspaceLine()).not.toContain("▼");
      expect(app.lines().join("\n")).not.toContain("Removing worktree…");
      app.unmount();
    });
  });

  test("validates after success, failure and a blocked removal, and only then drops the Workspace", async () => {
    // --- Success: validation runs while the lifecycle is STILL present, so
    // nothing removes the Workspace from the tree ahead of the refresh.
    const removed = trackLifecycle();
    let phaseAtRefresh: string | null = null;
    let entriesAtRefresh = -1;
    const removedDeps = makeDeps({
      setLifecycle: removed.setLifecycle,
      refreshAll: vi.fn(async () => {
        const entry = removed.entry();
        phaseAtRefresh = entry ? lifecyclePhaseLabel(entry.phase) : null;
        entriesAtRefresh = removed.state.size;
        return [];
      }),
    });
    const success = await startClose(removedDeps);
    emitWorkspacePhase(success.call, { _tag: "RemovingWorktree" });
    success.call.resolve(makeCloseResult());
    await success.settled;

    expect(removed.labels()).toEqual([
      "Preparing Workspace…",
      "Removing worktree…",
      "Validating Workspace…",
      null,
    ]);
    expect(phaseAtRefresh).toBe("Validating Workspace…");
    expect(entriesAtRefresh).toBe(1);
    expect(removed.state.size).toBe(0);

    // --- Failure.
    const failed = trackLifecycle();
    const failure = await startClose(
      makeDeps({ setLifecycle: failed.setLifecycle }),
    );
    failure.call.reject(new Error("worktree busy"));
    await failure.settled;
    expect(failed.labels()).toContain("Validating Workspace…");
    expect(failed.labels().at(-1)).toBeNull();

    // --- Blocked by changes.
    const blocked = trackLifecycle();
    const blockedRun = await startClose(
      makeDeps({ setLifecycle: blocked.setLifecycle }),
    );
    blockedRun.call.resolve(blockedResult());
    await blockedRun.settled;
    expect(blocked.labels()).toContain("Validating Workspace…");
    expect(blocked.labels().at(-1)).toBeNull();
  });

  test("an unsuccessful close removes progress, restores expansion, and reports afterwards", async () => {
    const tracker = trackLifecycle();
    const deps = makeDeps({ setLifecycle: tracker.setLifecycle });
    const run = await startClose(deps);
    expect(tracker.state.size).toBe(1);
    // The lifecycle state the tree WOULD be rendering mid-flight, captured
    // before teardown so the before/after comparison below has two real sides.
    const midFlight: LifecycleState = new Map(tracker.state);

    run.call.reject(new Error("worktree has untracked files"));
    await run.settled;

    // Progress is gone.
    expect(tracker.state.size).toBe(0);
    expect(tracker.labels().at(-1)).toBeNull();

    // Expansion was a presentation override, never a stored write: mid-flight
    // the Workspace was presented as expanded no matter what the user's own
    // preference said, and with the entry gone the preference alone decides —
    // while nothing in these deps could ever write that preference.
    expect(deps).not.toHaveProperty("setExpandedWorktreeKeys");
    for (const stored of [new Set<string>(), new Set([WORKTREE_KEY])]) {
      const forThisPreference = (lifecycle: LifecycleState) =>
        isWorktreeEffectivelyExpanded({
          expandedWorktreeKeys: stored,
          lifecycle,
          project: PROJECT,
          repoPath: REPO_PATH,
          branch: BRANCH,
        });
      expect(forThisPreference(midFlight)).toBe(true);
      expect(forThisPreference(tracker.state)).toBe(stored.has(WORKTREE_KEY));
    }

    // The outcome is reported through the existing timed error display, and
    // only after validation.
    expect(deps.showActionError).toHaveBeenCalledWith(
      "worktree has untracked files",
    );
    const refreshOrder = vi.mocked(deps.refreshAll).mock
      .invocationCallOrder[0] as number;
    const errorOrder = vi.mocked(deps.showActionError).mock
      .invocationCallOrder[0] as number;
    expect(errorOrder).toBeGreaterThan(refreshOrder);
  });

  test("a blocked close hands over to the force confirmation with no lifecycle left behind", async () => {
    const tracker = trackLifecycle();
    let entriesAtConfirm = -1;
    const setMode = vi.fn((mode) => {
      if (mode.type === "ConfirmCloseForce") {
        entriesAtConfirm = tracker.state.size;
      }
    });
    const deps = makeDeps({ setLifecycle: tracker.setLifecycle, setMode });

    const run = await startClose(deps);
    emitWorkspacePhase(run.call, { _tag: "RemovingWorktree" });
    run.call.resolve(blockedResult());
    await run.settled;

    // The confirmation is anchored against a finished lifecycle: validation
    // ran, the progress row is gone, and no lock is left on the identity.
    expect(setMode).toHaveBeenCalledWith(
      Mode.ConfirmCloseForce(
        "feat",
        BRANCH,
        WORKTREE_PATH,
        WORKTREE_KEY,
        REPO_PATH,
        PROJECT,
      ),
    );
    expect(entriesAtConfirm).toBe(0);
    expect(tracker.state.size).toBe(0);
    const refreshOrder = vi.mocked(deps.refreshAll).mock
      .invocationCallOrder[0] as number;
    const confirmOrder = setMode.mock.invocationCallOrder.at(-1) as number;
    expect(confirmOrder).toBeGreaterThan(refreshOrder);

    // --- Confirming force starts a DISTINCT new lifecycle presentation.
    const forced = trackLifecycle();
    const forcedDeps = makeDeps({ setLifecycle: forced.setLifecycle });
    const forcedRun = await startClose(forcedDeps, true);
    expect(forcedRun.call.options.force).toBe(true);
    expect(forcedRun.call.options.reporter).toBeDefined();
    expect(forced.labels()).toEqual(["Preparing Workspace…"]);
    forcedRun.call.resolve(makeCloseResult());
    await forcedRun.settled;
    expect(forced.state.size).toBe(0);

    // --- Cancelling leaves no lifecycle state, no lock and no stale phase.
    const { handleConfirmCloseInput } = await import(
      "../../src/tui/input/confirm-close"
    );
    const cancelSetMode = vi.fn();
    const executeClose = vi.fn();
    handleConfirmCloseInput(
      {
        mode: Mode.ConfirmCloseForce(
          "feat",
          BRANCH,
          WORKTREE_PATH,
          WORKTREE_KEY,
          REPO_PATH,
          PROJECT,
        ),
        returnMode: Mode.Navigate,
        returnSelectedIndex: 3,
        setMode: cancelSetMode,
        setSelectedIndex: vi.fn(),
        executeClose,
      },
      ESCAPE,
      { escape: true } as never,
    );
    expect(cancelSetMode).toHaveBeenCalledWith(Mode.Navigate);
    expect(executeClose).not.toHaveBeenCalled();
  });

  test("does not present the force confirmation over whatever the user moved on to", async () => {
    const tracker = trackLifecycle();
    const modeRef = { current: Mode.Navigate };
    const setMode = vi.fn((next: Mode) => {
      modeRef.current = next;
    });
    const deps = makeDeps({
      setLifecycle: tracker.setLifecycle,
      setMode,
      modeRef,
      // Validation is slow, and the user starts a search while it runs.
      refreshAll: vi.fn(async () => {
        modeRef.current = Mode.Search;
        return [];
      }),
    });

    const run = await startClose(deps);
    run.call.resolve(blockedResult());
    await run.settled;

    // The question is not asked — the search is left alone — but the refusal is
    // still reported, so it is never silent.
    expect(setMode).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "ConfirmCloseForce" }),
    );
    expect(modeRef.current).toEqual(Mode.Search);
    expect(deps.showActionError).toHaveBeenCalledWith(
      `Worktree '${BRANCH}' has uncommitted changes — press c to close it with force`,
    );
    expect(tracker.state.size).toBe(0);
  });
});

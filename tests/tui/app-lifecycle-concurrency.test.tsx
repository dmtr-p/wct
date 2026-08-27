// Lifecycle identity concurrency (proven against `beginLifecycle`) and the
// one-time viewport reveal (proven against the real App).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HEADER_OFFSET } from "../../src/tui/input/mouse";
import {
  beginLifecycle,
  createLifecycleClaims,
  type LifecycleController,
  type LifecycleEntry,
  type LifecyclePhase,
  type LifecycleState,
  lifecycleKey,
  lifecyclePhaseLabel,
  runLifecycleOperation,
} from "../../src/tui/lifecycle";
import { resolveLifecycleReveal } from "../../src/tui/tree-helpers";
import {
  emitWorkspacePhase,
  lastWorkspaceCall,
  makeWorktree,
  renderApp,
  resetHarnessFixtures,
  sendKeys,
  setTallWorktrees,
  sgrWheel,
  tick,
  worktreeFixtures,
} from "./app-harness";

const ENTER = "\r";
const CTRL_ENTER = "\x1b[13;5u";
const DOWN = "\x1b[B";

/** A live `setLifecycle` stand-in: applies updates exactly as React would. */
function trackLifecycle() {
  const tracker = {
    state: new Map() as LifecycleState,
    setLifecycle: (
      update: LifecycleState | ((prev: LifecycleState) => LifecycleState),
    ) => {
      tracker.state =
        typeof update === "function" ? update(tracker.state) : update;
      return tracker.state;
    },
    phaseOf: (repoPath: string, branch: string): LifecyclePhase | undefined =>
      tracker.state.get(lifecycleKey(repoPath, branch))?.phase,
  };
  return tracker;
}

function entryFor(
  repoPath: string,
  project: string,
  branch: string,
  operation: LifecycleEntry["operation"] = "open",
): LifecycleEntry {
  return { operation, repoPath, project, branch, phase: { _tag: "Preparing" } };
}

describe("lifecycle identity", () => {
  test("keys lifecycle state by (main repository path, branch) alone", () => {
    const tracker = trackLifecycle();
    const claims = createLifecycleClaims();
    const showActionError = vi.fn();
    const begin = (entry: LifecycleEntry) =>
      beginLifecycle({
        claims,
        setLifecycle: tracker.setLifecycle,
        entry,
        showActionError,
      });

    // Both repos share the project display name "alpha"; only their main
    // repository paths differ.
    const one = begin(entryFor("/repos/one", "alpha", "feature/x"));
    const two = begin(entryFor("/repos/two", "alpha", "feature/x", "up"));
    const sibling = begin(entryFor("/repos/one", "alpha", "feature/y", "down"));
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(sibling).not.toBeNull();
    expect(tracker.state.size).toBe(3);

    one?.setPhase({ _tag: "CreatingWorktree" });
    two?.setPhase({ _tag: "CreatingTmuxSession" });
    sibling?.setPhase({ _tag: "KillingTmuxSession" });
    expect(tracker.phaseOf("/repos/one", "feature/x")).toEqual({
      _tag: "CreatingWorktree",
    });
    expect(tracker.phaseOf("/repos/two", "feature/x")).toEqual({
      _tag: "CreatingTmuxSession",
    });
    expect(tracker.phaseOf("/repos/one", "feature/y")).toEqual({
      _tag: "KillingTmuxSession",
    });

    // Neither the project display name nor any registry id participates in
    // the key space.
    expect([...tracker.state.keys()]).toEqual([
      lifecycleKey("/repos/one", "feature/x"),
      lifecycleKey("/repos/two", "feature/x"),
      lifecycleKey("/repos/one", "feature/y"),
    ]);
    for (const key of tracker.state.keys()) {
      expect(key).not.toContain("alpha");
    }

    expect(begin(entryFor("/repos/one", "alpha", "feature/x"))).toBeNull();
    expect(tracker.state.size).toBe(3);
    expect(tracker.phaseOf("/repos/two", "feature/x")).toEqual({
      _tag: "CreatingTmuxSession",
    });

    one?.end();
    expect(tracker.state.size).toBe(2);
    expect(tracker.phaseOf("/repos/one", "feature/x")).toBeUndefined();
    expect(tracker.phaseOf("/repos/two", "feature/x")).toEqual({
      _tag: "CreatingTmuxSession",
    });
    expect(tracker.phaseOf("/repos/one", "feature/y")).toEqual({
      _tag: "KillingTmuxSession",
    });
    expect(begin(entryFor("/repos/two", "alpha", "feature/x"))).toBeNull();
    expect(begin(entryFor("/repos/one", "alpha", "feature/x"))).not.toBeNull();
    expect(begin(entryFor("/repos/one", "alpha", "feature/y"))).toBeNull();
  });

  test("refuses a second operation for one identity before it can overwrite it", async () => {
    const tracker = trackLifecycle();
    const claims = createLifecycleClaims();
    const showActionError = vi.fn();

    const active = beginLifecycle({
      claims,
      setLifecycle: tracker.setLifecycle,
      entry: entryFor("/repos/one", "alpha", "feature/x"),
      showActionError,
    });
    active?.setPhase({ _tag: "RunningSetup", name: "install" });
    expect(showActionError).not.toHaveBeenCalled();

    const refused = beginLifecycle({
      claims,
      setLifecycle: tracker.setLifecycle,
      entry: entryFor("/repos/one", "alpha", "feature/x", "close"),
      showActionError,
    });
    expect(refused).toBeNull();
    expect(tracker.state.size).toBe(1);
    expect(tracker.phaseOf("/repos/one", "feature/x")).toEqual({
      _tag: "RunningSetup",
      name: "install",
    });
    expect(showActionError).toHaveBeenCalledTimes(1);
    const message = showActionError.mock.calls[0]?.[0] as string;
    expect(message).toContain("feature/x");
    expect(message).toContain(
      lifecyclePhaseLabel({ _tag: "RunningSetup", name: "install" }),
    );

    // The same refusal applies through `runLifecycleOperation`.
    const run = vi.fn();
    await runLifecycleOperation({
      claims,
      setLifecycle: tracker.setLifecycle,
      refreshAll: () => Promise.resolve([]),
      showActionError,
      entry: entryFor("/repos/one", "alpha", "feature/x", "down"),
      run,
    });
    expect(run).not.toHaveBeenCalled();
    expect(showActionError).toHaveBeenCalledTimes(2);
    expect(tracker.state.size).toBe(1);
    expect(tracker.phaseOf("/repos/one", "feature/x")).toEqual({
      _tag: "RunningSetup",
      name: "install",
    });

    active?.end();
    expect(tracker.state.size).toBe(0);
    const later = beginLifecycle({
      claims,
      setLifecycle: tracker.setLifecycle,
      entry: entryFor("/repos/one", "alpha", "feature/x", "close"),
      showActionError,
    });
    expect(later).not.toBeNull();
  });
});

describe("lifecycle teardown is scoped to its own operation", () => {
  // Every flow tears down twice — once inline, once from a `finally` — with
  // real awaits in between, during which a second operation may legitimately
  // claim the same identity; the trailing teardown must not touch it.
  test("a trailing teardown neither deletes nor unlocks a successor's operation", () => {
    const tracker = trackLifecycle();
    const claims = createLifecycleClaims();
    const showActionError = vi.fn();
    const begin = (entry: LifecycleEntry) =>
      beginLifecycle({
        claims,
        setLifecycle: tracker.setLifecycle,
        entry,
        showActionError,
      });

    const first = begin(entryFor("/repos/one", "alpha", "feature/x", "up"));
    first?.end();
    expect(tracker.state.size).toBe(0);

    const second = begin(entryFor("/repos/one", "alpha", "feature/x", "down"));
    expect(second).not.toBeNull();
    second?.setPhase({ _tag: "KillingTmuxSession" });

    first?.end();
    first?.setPhase({ _tag: "CopyingFiles" });
    expect(tracker.state.size).toBe(1);
    expect(tracker.phaseOf("/repos/one", "feature/x")).toEqual({
      _tag: "KillingTmuxSession",
    });
    expect(claims.active("/repos/one", "feature/x")?.operation).toBe("down");
    expect(begin(entryFor("/repos/one", "alpha", "feature/x"))).toBeNull();
  });

  test("the shared run shape's finally cannot clobber an operation started during the hand-off", async () => {
    const tracker = trackLifecycle();
    const claims = createLifecycleClaims();
    const showActionError = vi.fn();
    const successor: { controller: LifecycleController | null } = {
      controller: null,
    };

    await runLifecycleOperation<string>({
      claims,
      setLifecycle: tracker.setLifecycle,
      refreshAll: () => Promise.resolve([]),
      showActionError,
      entry: entryFor("/repos/one", "alpha", "feature/x", "up"),
      run: () => Promise.resolve("done"),
      // `afterCleanup` runs after the inline teardown, standing in for the
      // real tmux hand-off's several awaited subprocess calls.
      afterCleanup: () => {
        successor.controller = beginLifecycle({
          claims,
          setLifecycle: tracker.setLifecycle,
          entry: entryFor("/repos/one", "alpha", "feature/x", "close"),
          showActionError,
        });
        successor.controller?.setPhase({ _tag: "RemovingWorktree" });
        return Promise.resolve(undefined);
      },
    });

    expect(successor.controller).not.toBeNull();
    expect(tracker.state.size).toBe(1);
    expect(tracker.phaseOf("/repos/one", "feature/x")).toEqual({
      _tag: "RemovingWorktree",
    });
    expect(claims.active("/repos/one", "feature/x")?.operation).toBe("close");
  });

  test("reports a throwing hand-off instead of losing every collected message", async () => {
    const tracker = trackLifecycle();
    const claims = createLifecycleClaims();
    const showActionError = vi.fn();

    await runLifecycleOperation<string>({
      claims,
      setLifecycle: tracker.setLifecycle,
      refreshAll: () => Promise.resolve([]),
      showActionError,
      entry: entryFor("/repos/one", "alpha", "feature/x", "up"),
      run: () => Promise.resolve("done"),
      resultWarnings: () => ["Optional setup failed: install"],
      afterCleanup: () => Promise.reject(new Error("switch-client exploded")),
    });

    expect(tracker.state.size).toBe(0);
    const reported = showActionError.mock.calls[0]?.[0] as string;
    expect(reported).toContain("Optional setup failed: install");
    expect(reported).toContain("switch-client exploded");
  });
});

/** Visible `feature/<n>` rows, in frame order — a signature of the window. */
function visibleFeatureIndices(lines: string[]): number[] {
  return lines.flatMap((line) => {
    const match = /feature\/(\d+)/.exec(line);
    return match?.[1] ? [Number(match[1])] : [];
  });
}

/** The first tree row of the frame, i.e. the row the scroll offset points at. */
function firstTreeLine(lines: string[]): string {
  return (lines[HEADER_OFFSET] ?? "").trim();
}

async function openBranchFromModal(stdin: NodeJS.ReadStream, branch: string) {
  await sendKeys(stdin, "o");
  await sendKeys(stdin, ENTER);
  await sendKeys(stdin, branch);
  await sendKeys(stdin, CTRL_ENTER);
}

describe("TUI lifecycle viewport reveal", () => {
  let homeDir: string;
  let repoPath: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "wct-app-concurrency-home-"));
    repoPath = mkdtempSync(join(tmpdir(), "wct-app-concurrency-repo-"));
    mkdirSync(join(homeDir, ".wct"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    resetHarnessFixtures();
    setTallWorktrees(repoPath, 20);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  test("reveals an off-screen lifecycle once and leaves a visible one alone", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />, 14);
    await tick(8);

    // Taller than the window: the repo row is on screen, the last worktrees
    // (where the Pending Workspace is placed) are not.
    const before = app.lines();
    expect(firstTreeLine(before)).toContain("alpha");
    expect(before.join("\n")).not.toContain("feature/19");

    await openBranchFromModal(app.stdin, "feature/new");
    await tick(8);

    const revealed = app.lines();
    const text = revealed.join("\n");
    expect(text).toContain("Preparing Workspace…");
    expect(text).toContain("feature/new");
    // A minimal downward nudge, never a re-centre: the progress row is the
    // bottom-most tree row of the window, moved just far enough that the
    // repo row scrolled off the top.
    const progressRow = revealed.findIndex((line) =>
      line.includes("Preparing Workspace…"),
    );
    expect(progressRow).toBeGreaterThan(HEADER_OFFSET);
    expect(revealed[progressRow - 1]).toContain("feature/new");
    expect(visibleFeatureIndices(revealed.slice(progressRow))).toEqual([]);
    expect(firstTreeLine(revealed)).not.toContain("alpha");
    expect(visibleFeatureIndices(revealed)).toContain(19);

    app.unmount();

    // A lifecycle that starts already visible must not move the viewport at
    // all, not even to centre itself.
    const app2 = await renderApp(<App />, 14);
    await tick(8);
    await sendKeys(app2.stdin, sgrWheel(1).repeat(4));
    await sendKeys(app2.stdin, DOWN);
    await tick(4);
    const beforeUp = app2.lines();
    const topBeforeUp = firstTreeLine(beforeUp);
    expect(topBeforeUp).toContain("main");
    expect(topBeforeUp).not.toContain("alpha");

    await sendKeys(app2.stdin, "u");
    await sendKeys(app2.stdin, CTRL_ENTER);
    await tick(8);

    const duringUp = app2.lines();
    expect(duringUp.join("\n")).toContain("Preparing Workspace…");
    expect(firstTreeLine(duringUp)).toContain("main");
    expect(firstTreeLine(duringUp)).not.toContain("alpha");
    expect(visibleFeatureIndices(duringUp)[0]).toBe(
      visibleFeatureIndices(beforeUp)[0],
    );

    app2.unmount();

    expect(
      resolveLifecycleReveal({
        rows: [],
        repos: [],
        lifecycle: new Map([
          [
            lifecycleKey(repoPath, "feature/new"),
            entryFor(repoPath, "alpha", "feature/new"),
          ],
        ]),
        revealed: new Set<string>(),
        scrollOffset: 7,
        viewportRows: 10,
      }),
    ).toBeNull();
  });

  // Driven through the real search filter rather than a hand-built
  // `resolveLifecycleReveal` call, since rows are built from `filteredRepos`.
  test("a lifecycle whose repository the active search excludes renders nothing and moves nothing", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />, 14);
    try {
      await tick(8);

      await openBranchFromModal(app.stdin, "feature/new");
      await tick(8);
      expect(app.lines().join("\n")).toContain("Preparing Workspace…");

      // "alpha" is the only project and no branch matches, so `filteredRepos`
      // ends up empty.
      await sendKeys(app.stdin, "/");
      await sendKeys(app.stdin, "zzz-no-such-repo");
      await tick(6);

      const filtered = app.lines();
      const filteredText = filtered.join("\n");
      expect(filteredText).not.toContain("Preparing Workspace…");
      expect(filteredText).not.toContain("feature/new");
      expect(visibleFeatureIndices(filtered)).toEqual([]);

      emitWorkspacePhase(lastWorkspaceCall("open"), {
        _tag: "CreatingWorktree",
      });
      await tick(4);
      expect(app.lines()).toEqual(filtered);
    } finally {
      app.unmount();
    }
  });

  test("never touches the offset again after the one reveal", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />, 14);
    await tick(8);

    await openBranchFromModal(app.stdin, "feature/new");
    await tick(8);
    const afterReveal = visibleFeatureIndices(app.lines());
    expect(app.lines().join("\n")).toContain("Preparing Workspace…");

    const call = lastWorkspaceCall("open");
    emitWorkspacePhase(call, { _tag: "CreatingWorktree" });
    await tick(4);
    expect(app.lines().join("\n")).toContain("Creating worktree…");
    expect(visibleFeatureIndices(app.lines())).toEqual(afterReveal);

    await sendKeys(app.stdin, sgrWheel(-1).repeat(4));
    await tick(4);
    const afterWheel = visibleFeatureIndices(app.lines());
    const topAfterWheel = firstTreeLine(app.lines());
    expect(afterWheel).not.toEqual(afterReveal);

    emitWorkspacePhase(call, { _tag: "RunningSetup", name: "install" });
    await tick(4);
    expect(visibleFeatureIndices(app.lines())).toEqual(afterWheel);
    expect(firstTreeLine(app.lines())).toBe(topAfterWheel);

    // Validation discovers the worktree and the lifecycle UI comes down,
    // all without undoing the user's scroll.
    worktreeFixtures.byRepoPath.set(repoPath, [
      ...(worktreeFixtures.byRepoPath.get(repoPath) ?? []),
      makeWorktree(repoPath, "feature/new"),
    ]);
    call.resolve({
      operation: "open",
      worktreePath: join(repoPath, "feature-new"),
      mainRepoPath: repoPath,
      branch: "feature/new",
      sessionName: "feature-new",
      projectName: "alpha",
      created: true,
      env: {},
      warnings: [],
      attempts: {
        worktree: { attempted: true, ok: true, value: {} },
        copy: { attempted: false, reason: "not_configured" },
        setup: { attempted: false, reason: "not_configured" },
        tmux: { attempted: false, reason: "not_configured" },
      },
    });
    await tick(14);

    const settled = app.lines();
    expect(settled.join("\n")).not.toContain("Preparing Workspace…");
    expect(settled.join("\n")).not.toContain("Creating worktree…");
    expect(settled.join("\n")).not.toContain("Validating Workspace…");
    expect(firstTreeLine(settled)).toBe(topAfterWheel);
    expect(visibleFeatureIndices(settled)).toEqual(afterWheel);

    app.unmount();
  });
});

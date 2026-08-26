import { Effect } from "effect";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { commandError } from "../../src/errors";
import {
  type WorkspaceCloseResult,
  type WorkspacePhase,
  type WorkspaceReporter,
  WorkspaceService,
  type WorkspaceUpResult,
} from "../../src/services/workspace-service";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import type { SessionActionDeps } from "../../src/tui/hooks/useSessionActions";
import {
  createExecuteClose,
  createExecuteDown,
  createHandleCloseSelectedWorktree,
  createHandleDownSelectedWorktree,
  createHandleSpaceSwitch,
  createSessionHandoff,
  createStartWorkspace,
  createSwitchClientAway,
} from "../../src/tui/hooks/useSessionActions";
import {
  createLifecycleClaims,
  type LifecycleEntry,
  type LifecyclePhase,
  type LifecycleState,
  lifecycleKey,
  lifecyclePhaseLabel,
} from "../../src/tui/lifecycle";
import {
  buildTreeItems,
  buildTreeRows,
  isWorktreeEffectivelyExpanded,
} from "../../src/tui/tree-helpers";
import { Mode, pendingKey, type TreeItem } from "../../src/tui/types";

const workspaceUp = vi.hoisted(() => vi.fn(() => "mock-workspace-effect"));
const workspaceDown = vi.hoisted(() => vi.fn(() => "mock-workspace-effect"));
const workspaceClose = vi.hoisted(() => vi.fn(() => "mock-workspace-effect"));

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../src/services/workspace-service", () => ({
  WorkspaceService: {
    use: vi.fn((f) =>
      f({ up: workspaceUp, down: workspaceDown, close: workspaceClose }),
    ),
  },
}));

function makeDeps(
  overrides: Partial<SessionActionDeps> = {},
): SessionActionDeps {
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
    refreshAll: vi.fn().mockResolvedValue(undefined),
    restoreConfirmationViewport: vi.fn(),
    confirmDownReturnModeRef: { current: Mode.Navigate },
    confirmDownReturnSelectedIndexRef: { current: 0 },
    confirmCloseReturnModeRef: { current: Mode.Navigate },
    confirmCloseReturnSelectedIndexRef: { current: 0 },
    ...overrides,
  };
}

function makeStartResult(
  overrides: Partial<WorkspaceUpResult> = {},
): WorkspaceUpResult {
  return {
    operation: "up",
    worktreePath: "/tmp/wt",
    mainRepoPath: "/tmp/repo",
    branch: "feat",
    sessionName: "wt-feat",
    projectName: "proj",
    env: {} as WorkspaceUpResult["env"],
    warnings: [],
    attempts: {
      tmux: { attempted: false, reason: "tmux_not_configured" },
    },
    ...overrides,
  };
}

function makeWorkspaceUpResult(
  overrides: Partial<WorkspaceUpResult> = {},
): WorkspaceUpResult {
  return {
    operation: "up" as const,
    worktreePath: "/tmp/wt",
    mainRepoPath: "/tmp/repo",
    branch: "feat",
    sessionName: "wt-feat",
    projectName: "proj",
    env: {} as WorkspaceUpResult["env"],
    warnings: [],
    attempts: {
      tmux: { attempted: false, reason: "tmux_not_configured" },
    },
    ...overrides,
  };
}

function makeWorkspaceCloseResult(
  overrides: Partial<WorkspaceCloseResult> = {},
): WorkspaceCloseResult {
  return {
    operation: "close",
    worktreePath: "/tmp/wt",
    sessionName: "wt",
    existed: true,
    status: "removed",
    attempts: {
      kill: { attempted: true, ok: true, value: null },
      remove: {
        attempted: true,
        ok: true,
        value: { _tag: "Removed", path: "/tmp/wt" },
      },
    },
    warnings: [],
    ...overrides,
  };
}

describe("createSwitchClientAway", () => {
  test("returns true when client is not attached to target session", async () => {
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
    });
    const switchAway = createSwitchClientAway(deps);

    const result = await switchAway("my-session");
    expect(result).toBe(true);
  });

  test("returns false when multiple clients discovered (blocked)", async () => {
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "multiple" }),
      refreshSessions: vi.fn().mockResolvedValue([{ name: "my-session" }]),
    });
    const switchAway = createSwitchClientAway(deps);

    const result = await switchAway("my-session");
    expect(result).toBe(false);
  });

  test("detaches client when it is attached to target and no fallback sessions", async () => {
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({
        type: "single",
        client: { tty: "/dev/pts/0", session: "my-session" },
      }),
      refreshSessions: vi.fn().mockResolvedValue([{ name: "my-session" }]),
      detachClient: vi.fn().mockResolvedValue(true),
    });
    const switchAway = createSwitchClientAway(deps);

    const result = await switchAway("my-session");
    expect(result).toBe(true);
    expect(deps.detachClient).toHaveBeenCalledWith({
      tty: "/dev/pts/0",
      session: "my-session",
    });
  });

  test("switches to fallback session when one exists", async () => {
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({
        type: "single",
        client: { tty: "/dev/pts/0", session: "target" },
      }),
      refreshSessions: vi
        .fn()
        .mockResolvedValue([{ name: "target" }, { name: "fallback" }]),
      switchSession: vi.fn().mockResolvedValue(true),
    });
    const switchAway = createSwitchClientAway(deps);

    const result = await switchAway("target");
    expect(result).toBe(true);
    expect(deps.switchSession).toHaveBeenCalledWith("fallback", {
      tty: "/dev/pts/0",
      session: "target",
    });
  });
});

describe("createSessionHandoff", () => {
  test("auto-switches when tmux succeeded and single client", async () => {
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({
        type: "single",
        client: { tty: "/dev/pts/0", session: "other" },
      }),
      switchSession: vi.fn().mockResolvedValue(true),
    });
    const handoff = createSessionHandoff(deps);

    const result = makeStartResult({
      attempts: {
        tmux: {
          attempted: true,
          ok: true,
          value: { _tag: "Created", sessionName: "wt-feat" },
        },
      },
    });

    await expect(handoff(result, true)).resolves.toBeUndefined();
    expect(deps.switchSession).toHaveBeenCalledWith("wt-feat", {
      tty: "/dev/pts/0",
      session: "other",
    });
    expect(deps.refreshSessions).toHaveBeenCalled();
  });

  test("reports a failed switch as a message instead of throwing", async () => {
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({
        type: "single",
        client: { tty: "/dev/pts/0", session: "other" },
      }),
      switchSession: vi.fn().mockResolvedValue(false),
    });
    const handoff = createSessionHandoff(deps);

    const result = makeStartResult({
      attempts: {
        tmux: {
          attempted: true,
          ok: true,
          value: { _tag: "Created", sessionName: "wt-feat" },
        },
      },
    });

    await expect(handoff(result, true)).resolves.toEqual(
      expect.stringContaining("failed to switch client"),
    );
  });

  test("does not switch when autoSwitch is false", async () => {
    const deps = makeDeps();
    const handoff = createSessionHandoff(deps);

    const result = makeStartResult({
      attempts: {
        tmux: {
          attempted: true,
          ok: true,
          value: { _tag: "Created", sessionName: "wt-feat" },
        },
      },
    });

    await expect(handoff(result, false)).resolves.toBeUndefined();
    expect(deps.switchSession).not.toHaveBeenCalled();
  });
});

describe("createHandleSpaceSwitch", () => {
  test("fires detail item action when selected", () => {
    const action = vi.fn();
    const items: TreeItem[] = [
      {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pr",
        label: "PR #42",
        meta: { rollupState: null },
        action,
      },
    ];
    const deps = makeDeps({
      treeItems: items,
      selectedIndex: 0,
    });
    const handleSpace = createHandleSpaceSwitch(deps);

    handleSpace();
    expect(action).toHaveBeenCalled();
  });

  test("switches to existing tmux session", () => {
    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const repos = [
      {
        id: "r1",
        project: "proj",
        repoPath: "/repo",
        profileNames: [],
        worktrees: [
          {
            branch: "main",
            path: "/repo/main",
            isMainWorktree: true,
            changedFiles: 0,
            sync: null,
          },
        ],
      },
    ];
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
      sessions: [{ name: "main", attached: false }],
      switchSession: vi.fn().mockResolvedValue(true),
    });
    const handleSpace = createHandleSpaceSwitch(deps);

    handleSpace();
    expect(deps.clearActionError).toHaveBeenCalled();
    expect(deps.switchSession).toHaveBeenCalledWith("main");
  });

  test("starts new session through the shared up lifecycle when none exists", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");

    const upResult = makeWorkspaceUpResult();
    (tuiRuntime.runPromise as Mock).mockResolvedValue(upResult);

    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const repos = [
      {
        id: "r1",
        project: "proj",
        repoPath: "/repo",
        profileNames: [],
        worktrees: [
          {
            branch: "feat",
            path: "/repo/feat",
            isMainWorktree: false,
            changedFiles: 0,
            sync: null,
          },
        ],
      },
    ];
    const setLifecycle = vi.fn();
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
      sessions: [],
      setLifecycle,
    });
    const handleSpace = createHandleSpaceSwitch(deps);

    handleSpace();

    expect(deps.clearActionError).toHaveBeenCalled();
    // Progress is a lifecycle entry now, not a coarse pending suffix.
    expect(setLifecycle).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(WorkspaceService.use).toHaveBeenCalled();
      expect(workspaceUp).toHaveBeenCalledWith({
        path: "/repo/feat",
        reporter: expect.anything(),
      });
      expect(tuiRuntime.runPromise).toHaveBeenCalledWith(
        "mock-workspace-effect",
      );
    });
    await vi.waitFor(() => {
      expect(deps.refreshAll).toHaveBeenCalled();
    });
  });

  test("preserves successful WorkspaceService.up tmux result for auto-switch", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");

    const upResult = makeWorkspaceUpResult({
      sessionName: "wt-feat",
      attempts: {
        tmux: {
          attempted: true,
          ok: true,
          value: { _tag: "Created", sessionName: "wt-feat" },
        },
      },
    });
    (tuiRuntime.runPromise as Mock).mockResolvedValue(upResult);

    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const repos = [
      {
        id: "r1",
        project: "proj",
        repoPath: "/repo",
        profileNames: [],
        worktrees: [
          {
            branch: "feat",
            path: "/repo/feat",
            isMainWorktree: false,
            changedFiles: 0,
            sync: null,
          },
        ],
      },
    ];
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
      sessions: [],
      discoverClient: vi.fn().mockResolvedValue({
        type: "single",
        client: { tty: "/dev/pts/0", session: "other" },
      }),
      switchSession: vi.fn().mockResolvedValue(true),
    });
    const handleSpace = createHandleSpaceSwitch(deps);

    handleSpace();

    await vi.waitFor(() => {
      expect(deps.switchSession).toHaveBeenCalledWith("wt-feat", {
        tty: "/dev/pts/0",
        session: "other",
      });
    });
  });

  test("shows error when start fails", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockRejectedValue(new Error("spawn fail"));

    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const repos = [
      {
        id: "r1",
        project: "proj",
        repoPath: "/repo",
        profileNames: [],
        worktrees: [
          {
            branch: "feat",
            path: "/repo/feat",
            isMainWorktree: false,
            changedFiles: 0,
            sync: null,
          },
        ],
      },
    ];
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
      sessions: [],
    });
    const handleSpace = createHandleSpaceSwitch(deps);

    handleSpace();

    // Wait for the async error handling to complete
    await vi.waitFor(() => {
      expect(deps.showActionError).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(deps.refreshAll).toHaveBeenCalled();
    });
  });
});

describe("createExecuteClose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("active-client safety failure prevents WorkspaceService.close", async () => {
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "multiple" }),
      refreshSessions: vi.fn().mockResolvedValue([{ name: "target-session" }]),
    });
    const executeClose = createExecuteClose(deps);

    await executeClose(
      "target-session",
      "feat",
      "/tmp/wt",
      "proj/feat",
      "/repo",
      "proj",
      false,
    );
    expect(deps.showActionError).toHaveBeenCalledWith(
      expect.stringContaining("could not be moved away"),
    );
    expect(workspaceClose).not.toHaveBeenCalled();
    // No lifecycle presentation is started for a close that never ran.
    expect(deps.setLifecycle).not.toHaveBeenCalled();
  });

  test("uses WorkspaceService.close, refreshes, and tears the lifecycle down after success", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValue(
      makeWorkspaceCloseResult(),
    );

    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
    });
    const executeClose = createExecuteClose(deps);

    await executeClose(
      "my-session",
      "feat",
      "/tmp/wt",
      "proj/feat",
      "/repo",
      "proj",
      false,
    );
    expect(WorkspaceService.use).toHaveBeenCalled();
    expect(workspaceClose).toHaveBeenCalledWith({
      path: "/tmp/wt",
      cwd: "/repo",
      reporter: expect.anything(),
    });
    expect(tuiRuntime.runPromise).toHaveBeenCalledWith("mock-workspace-effect");
    expect(deps.setLifecycle).toHaveBeenCalled();
    expect(deps.refreshAll).toHaveBeenCalled();
    expect(deps.restoreConfirmationViewport).toHaveBeenCalledOnce();
    expect(deps.showActionError).not.toHaveBeenCalled();
  });

  test("passes selected repoPath as WorkspaceService.close cwd for multi-repo TUI close", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValue(
      makeWorkspaceCloseResult(),
    );

    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
    });
    const executeClose = createExecuteClose(deps);

    await executeClose(
      "my-session",
      "feat",
      "/tmp/wt",
      "proj/feat",
      "/registered/repo",
      "proj",
      false,
    );

    expect(workspaceClose).toHaveBeenCalledWith({
      path: "/tmp/wt",
      cwd: "/registered/repo",
      reporter: expect.anything(),
    });
  });

  test("moves active client before WorkspaceService.close", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValue(
      makeWorkspaceCloseResult(),
    );

    const calls: string[] = [];
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({
        type: "single",
        client: { tty: "/dev/pts/0", session: "my-session" },
      }),
      refreshSessions: vi
        .fn()
        .mockResolvedValue([{ name: "my-session" }, { name: "fallback" }]),
      switchSession: vi.fn().mockImplementation(async () => {
        calls.push("switch");
        return true;
      }),
    });
    workspaceClose.mockImplementationOnce(() => {
      calls.push("close");
      return "mock-workspace-effect";
    });
    const executeClose = createExecuteClose(deps);

    await executeClose(
      "my-session",
      "feat",
      "/tmp/wt",
      "proj/feat",
      "/repo",
      "proj",
      false,
    );

    expect(calls).toEqual(["switch", "close"]);
    expect(deps.switchSession).toHaveBeenCalledWith("fallback", {
      tty: "/dev/pts/0",
      session: "my-session",
    });
    expect(workspaceClose).toHaveBeenCalledWith({
      path: "/tmp/wt",
      cwd: "/repo",
      reporter: expect.anything(),
    });
  });

  test("blocked close enters force-confirm mode and refreshes", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValue(
      makeWorkspaceCloseResult({
        status: "blocked_by_changes",
        attempts: {
          kill: { attempted: true, ok: true, value: null },
          remove: {
            attempted: true,
            ok: true,
            value: { _tag: "BlockedByChanges", path: "/tmp/wt" },
          },
        },
      }),
    );

    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
    });
    const executeClose = createExecuteClose(deps);

    await executeClose(
      "my-session",
      "feat",
      "/tmp/wt",
      "proj/feat",
      "/repo",
      "proj",
      false,
    );
    expect(workspaceClose).toHaveBeenCalledWith({
      path: "/tmp/wt",
      cwd: "/repo",
      reporter: expect.anything(),
    });
    expect(deps.setMode).toHaveBeenCalledWith(
      Mode.ConfirmCloseForce(
        "my-session",
        "feat",
        "/tmp/wt",
        "proj/feat",
        "/repo",
        "proj",
      ),
    );
    expect(deps.restoreConfirmationViewport).toHaveBeenCalledOnce();
    expect(
      vi.mocked(deps.restoreConfirmationViewport).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(deps.setMode).mock.invocationCallOrder[0] ?? 0);
    expect(deps.refreshAll).toHaveBeenCalled();
  });

  test("force close calls WorkspaceService.close with force", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValue(
      makeWorkspaceCloseResult(),
    );

    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
    });
    const executeClose = createExecuteClose(deps);

    await executeClose(
      "my-session",
      "feat",
      "/tmp/wt",
      "proj/feat",
      "/repo",
      "proj",
      true,
    );

    expect(workspaceClose).toHaveBeenCalledWith({
      path: "/tmp/wt",
      cwd: "/repo",
      force: true,
      reporter: expect.anything(),
    });
    expect(deps.refreshAll).toHaveBeenCalled();
  });

  test("surfaces WorkspaceService.close tmux kill failure", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockRejectedValue(
      commandError("tmux_error", "kill failed"),
    );

    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
    });
    const executeClose = createExecuteClose(deps);

    await executeClose(
      "my-session",
      "feat",
      "/tmp/wt",
      "proj/feat",
      "/repo",
      "proj",
      false,
    );

    expect(workspaceClose).toHaveBeenCalledWith({
      path: "/tmp/wt",
      cwd: "/repo",
      reporter: expect.anything(),
    });
    expect(deps.showActionError).toHaveBeenCalledWith("kill failed");
    expect(deps.refreshAll).toHaveBeenCalled();
  });
});

describe("createExecuteDown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls switchClientAway first and aborts on failure", async () => {
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "multiple" }),
      refreshSessions: vi.fn().mockResolvedValue([{ name: "target-session" }]),
    });
    const executeDown = createExecuteDown(deps);

    await executeDown("target-session", "feat", "/tmp/wt", "/repo", "proj");

    expect(deps.showActionError).toHaveBeenCalledWith(
      expect.stringContaining("could not be moved away"),
    );
    expect(deps.setLifecycle).not.toHaveBeenCalled();
  });

  test("uses WorkspaceService.down and refreshes after kill success", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValue({
      operation: "down",
      worktreePath: "/tmp/wt",
      sessionName: "wt",
      existed: true,
      status: "killed",
      attempts: { kill: { attempted: true, ok: true, value: null } },
      warnings: [],
    });

    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
    });
    const executeDown = createExecuteDown(deps);

    await executeDown("wt", "feat", "/tmp/wt", "/repo", "proj");

    expect(WorkspaceService.use).toHaveBeenCalled();
    expect(workspaceDown).toHaveBeenCalledWith({
      path: "/tmp/wt",
      reporter: expect.anything(),
    });
    expect(tuiRuntime.runPromise).toHaveBeenCalledWith("mock-workspace-effect");
    expect(deps.refreshAll).toHaveBeenCalled();
    expect(deps.restoreConfirmationViewport).toHaveBeenCalledOnce();
    expect(
      vi.mocked(deps.restoreConfirmationViewport).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(deps.setMode).mock.invocationCallOrder[0] ?? 0);
    expect(deps.showActionError).not.toHaveBeenCalled();
    // No coarse `stopping…` suffix any more — the progress row tells the story.
    expect(deps.setLifecycle).toHaveBeenCalled();
  });

  test("treats absent-session down as informational success", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValue({
      operation: "down",
      worktreePath: "/tmp/wt",
      sessionName: "wt",
      existed: false,
      status: "absent",
      attempts: { kill: { attempted: false, reason: "session_absent" } },
      warnings: [],
    });

    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
    });
    const executeDown = createExecuteDown(deps);

    await executeDown("wt", "feat", "/tmp/wt", "/repo", "proj");

    expect(deps.refreshAll).toHaveBeenCalled();
    expect(deps.showActionError).not.toHaveBeenCalled();
  });

  test("reaches WorkspaceService.down for absent target session even with ambiguous clients", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValue({
      operation: "down",
      worktreePath: "/tmp/wt",
      sessionName: "wt",
      existed: false,
      status: "absent",
      attempts: { kill: { attempted: false, reason: "session_absent" } },
      warnings: [],
    });

    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "multiple" }),
      refreshSessions: vi.fn().mockResolvedValue([{ name: "main" }]),
    });
    const executeDown = createExecuteDown(deps);

    await executeDown("wt", "feat", "/tmp/wt", "/repo", "proj");

    expect(workspaceDown).toHaveBeenCalledWith({
      path: "/tmp/wt",
      reporter: expect.anything(),
    });
    expect(deps.showActionError).not.toHaveBeenCalled();
    expect(deps.refreshAll).toHaveBeenCalled();
  });

  test("surfaces WorkspaceService.down failure and clears pending", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockRejectedValue(
      commandError("tmux_error", "kill failed"),
    );

    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
    });
    const executeDown = createExecuteDown(deps);

    await executeDown("wt", "feat", "/tmp/wt", "/repo", "proj");

    expect(deps.showActionError).toHaveBeenCalledWith("kill failed");
    expect(deps.refreshAll).toHaveBeenCalled();
  });
});

describe("createHandleDownSelectedWorktree", () => {
  test("no-op when selected item is not a worktree", () => {
    const items: TreeItem[] = [{ type: "repo", repoIndex: 0 }];
    const deps = makeDeps({
      treeItems: items,
      selectedIndex: 0,
    });
    const handleDown = createHandleDownSelectedWorktree(deps);

    handleDown();
    expect(deps.setMode).not.toHaveBeenCalled();
  });

  test("no-op when worktree has no active session", () => {
    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const repos = [
      {
        id: "r1",
        project: "proj",
        repoPath: "/repo",
        profileNames: [],
        worktrees: [
          {
            branch: "feat",
            path: "/repo/feat",
            isMainWorktree: false,
            changedFiles: 0,
            sync: null,
          },
        ],
      },
    ];
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
      sessions: [],
    });
    const handleDown = createHandleDownSelectedWorktree(deps);

    handleDown();
    expect(deps.setMode).not.toHaveBeenCalled();
  });

  test("saves return refs and sets ConfirmDown mode when session exists", () => {
    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const repos = [
      {
        id: "r1",
        project: "proj",
        repoPath: "/repo",
        profileNames: [],
        worktrees: [
          {
            branch: "feat",
            path: "/repo/feat",
            isMainWorktree: false,
            changedFiles: 0,
            sync: null,
          },
        ],
      },
    ];
    const returnModeRef = { current: Mode.Navigate };
    const returnIndexRef = { current: 0 };
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
      sessions: [{ name: "feat", attached: false }],
      confirmDownReturnModeRef: returnModeRef,
      confirmDownReturnSelectedIndexRef: returnIndexRef,
    });
    const handleDown = createHandleDownSelectedWorktree(deps);

    handleDown();
    expect(returnIndexRef.current).toBe(0);
    expect(returnModeRef.current).toEqual(Mode.Navigate);
    expect(deps.setMode).toHaveBeenCalledWith(
      Mode.ConfirmDown(
        "feat",
        "feat",
        "/repo/feat",
        "proj/feat",
        "/repo",
        "proj",
      ),
    );
  });

  test("preserves Expanded mode in return ref", () => {
    const worktreeKey = pendingKey("proj", "feat");
    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const repos = [
      {
        id: "r1",
        project: "proj",
        repoPath: "/repo",
        profileNames: [],
        worktrees: [
          {
            branch: "feat",
            path: "/repo/feat",
            isMainWorktree: false,
            changedFiles: 0,
            sync: null,
          },
        ],
      },
    ];
    const returnModeRef = { current: Mode.Navigate };
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
      mode: Mode.Expanded(worktreeKey),
      sessions: [{ name: "feat", attached: false }],
      confirmDownReturnModeRef: returnModeRef,
    });
    const handleDown = createHandleDownSelectedWorktree(deps);

    handleDown();
    expect(returnModeRef.current).toEqual(Mode.Expanded(worktreeKey));
  });
});

describe("a Workspace under an active lifecycle", () => {
  const repoPath = "/repo";
  const branch = "main";

  function repos(): RepoInfo[] {
    return [
      {
        id: "r1",
        project: "proj",
        repoPath,
        profileNames: [],
        worktrees: [
          {
            branch,
            path: "/repo/main",
            isMainWorktree: true,
            changedFiles: 3,
            sync: { ahead: 1, behind: 0 },
          },
        ],
      },
    ];
  }

  function lifecycleFor(): LifecycleState {
    const entry: LifecycleEntry = {
      operation: "open",
      repoPath,
      project: "proj",
      branch,
      phase: { _tag: "CreatingWorktree" },
    };
    return new Map([[lifecycleKey(repoPath, branch), entry]]);
  }

  // AC-9
  test("is presented expanded with details hidden, stays selectable, and refuses actions", () => {
    const lifecycle = lifecycleFor();
    const repoList = repos();
    const worktreeKey = pendingKey("proj", branch);

    // --- Presentation: expanded, but stats/PR/pane detail rows suppressed.
    const items = buildTreeItems({
      repos: repoList,
      expandedWorktreeKeys: new Set([worktreeKey]),
      lifecycle,
      prData: new Map([
        [
          worktreeKey,
          {
            number: 7,
            title: "Add thing",
            state: "OPEN" as const,
            headRefName: branch,
            rollupState: null,
          },
        ],
      ]),
      panes: new Map([
        [
          "main",
          [
            {
              paneId: "%1",
              paneIndex: 0,
              command: "vim",
              window: "0",
              zoomed: false,
              active: true,
            },
          ],
        ],
      ]),
      jumpToPane: () => undefined,
    });
    expect(items.some((item) => item.type === "detail")).toBe(false);

    const rows = buildTreeRows({
      items,
      repos: repoList,
      expandedRepos: new Set(["r1"]),
      expandedWorktreeKeys: new Set([worktreeKey]),
      lifecycle,
      maxWidth: 80,
    });
    expect(rows.some((row) => row.kind === "worktree-stats")).toBe(false);
    expect(
      rows.filter((row) => row.kind === "lifecycle-progress"),
    ).toHaveLength(1);
    // The parent branch row itself stays selectable / arrow-key reachable.
    const worktreeItemIndex = items.findIndex(
      (item) => item.type === "worktree",
    );
    expect(worktreeItemIndex).toBeGreaterThan(-1);
    expect(
      rows.some(
        (row) => row.kind === "worktree" && row.itemIndex === worktreeItemIndex,
      ),
    ).toBe(true);

    // --- Actions targeting it are refused, through the timed error display.
    const treeItems: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const deps = makeDeps({
      treeItems,
      filteredRepos: repoList,
      selectedIndex: 0,
      sessions: [{ name: "main", attached: false }],
      lifecycle,
      switchSession: vi.fn().mockResolvedValue(true),
    });

    createHandleSpaceSwitch(deps)();
    createHandleDownSelectedWorktree(deps)();
    createHandleCloseSelectedWorktree(deps)();

    expect(deps.switchSession).not.toHaveBeenCalled();
    expect(deps.setMode).not.toHaveBeenCalled();
    expect(deps.showActionError).toHaveBeenCalledTimes(3);
    for (const call of (deps.showActionError as Mock).mock.calls) {
      expect(String(call[0])).toContain(branch);
    }

    // Without a lifecycle the same actions go through, so the guard is the
    // only thing refusing them.
    const free = makeDeps({
      treeItems,
      filteredRepos: repoList,
      selectedIndex: 0,
      sessions: [{ name: "main", attached: false }],
      switchSession: vi.fn().mockResolvedValue(true),
    });
    createHandleSpaceSwitch(free)();
    expect(free.switchSession).toHaveBeenCalled();
  });
});

/**
 * Start/stop lifecycle presentation. `createStartWorkspace` is the ONE `up`
 * path behind both the space-bar start and the up modal, so driving it here
 * covers both entry points; `createExecuteDown` is the `down` path.
 *
 * Each case drives the reporter the handler passes to the service, so the
 * assertions are on the phases the tree WOULD render, in order.
 */
describe("up and down lifecycle progress", () => {
  const repoPath = "/repo";
  const branch = "feat";
  const worktreeKey = pendingKey("proj", branch);

  beforeEach(() => {
    vi.clearAllMocks();
  });

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
        tracker.state.get(lifecycleKey(repoPath, branch)),
      labels: () =>
        tracker.phases.map((phase) =>
          phase ? lifecyclePhaseLabel(phase) : null,
        ),
    };
    return tracker;
  }

  /**
   * Stands in for the service: emits exactly the phases a real run with this
   * configuration would emit, through the reporter the handler passed in, then
   * settles.
   */
  function serviceEmitting(
    serviceMock: typeof workspaceUp,
    operation: "up" | "down",
    phases: WorkspacePhase[],
    settle: () => Promise<unknown>,
  ) {
    return async () => {
      const options = (serviceMock as unknown as Mock).mock.calls.at(-1)?.[0] as
        | { reporter?: WorkspaceReporter }
        | undefined;
      const reporter = options?.reporter;
      if (!reporter) {
        throw new Error("service was called without a progress reporter");
      }
      for (const phase of phases) {
        await Effect.runPromise(
          reporter.event({ operation, _tag: "PhaseStarted", phase }),
        );
      }
      return settle();
    };
  }

  function repos(): RepoInfo[] {
    return [
      {
        id: "r1",
        project: "proj",
        repoPath,
        profileNames: [],
        worktrees: [
          {
            branch,
            path: "/repo/feat",
            isMainWorktree: false,
            changedFiles: 3,
            sync: { ahead: 1, behind: 0 },
          },
        ],
      },
    ];
  }

  function target(overrides: Record<string, unknown> = {}) {
    return {
      worktreePath: "/repo/feat",
      repoPath,
      project: "proj",
      branch,
      autoSwitch: false,
      ...overrides,
    };
  }

  // AC-19
  test("up shows Preparing, and Creating tmux session only when attempted", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");

    // --- tmux configured: the creation phase is emitted and rendered.
    const configured = trackLifecycle();
    (tuiRuntime.runPromise as Mock).mockImplementation(
      serviceEmitting(
        workspaceUp,
        "up",
        [{ _tag: "CreatingTmuxSession" }],
        () =>
          Promise.resolve(
            makeWorkspaceUpResult({
              attempts: {
                tmux: {
                  attempted: true,
                  ok: true,
                  value: { _tag: "Created", sessionName: "wt-feat" },
                },
              },
            }),
          ),
      ),
    );

    await createStartWorkspace(
      makeDeps({ setLifecycle: configured.setLifecycle }),
    )(target());

    expect(configured.labels()).toEqual([
      "Preparing Workspace…",
      "Creating tmux session…",
      "Validating Workspace…",
      null,
    ]);

    // --- tmux not configured: no creation is attempted, so no row for it.
    const skipped = trackLifecycle();
    (tuiRuntime.runPromise as Mock).mockImplementation(
      serviceEmitting(workspaceUp, "up", [], () =>
        Promise.resolve(makeWorkspaceUpResult()),
      ),
    );

    await createStartWorkspace(
      makeDeps({ setLifecycle: skipped.setLifecycle }),
    )(target());

    expect(skipped.labels()).toEqual([
      "Preparing Workspace…",
      "Validating Workspace…",
      null,
    ]);
    expect(skipped.labels()).not.toContain("Creating tmux session…");
  });

  // AC-20
  test("down shows Preparing, and Killing tmux session only when a kill is attempted", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");

    // --- a session exists: the kill phase is emitted and rendered.
    const killed = trackLifecycle();
    (tuiRuntime.runPromise as Mock).mockImplementation(
      serviceEmitting(
        workspaceDown,
        "down",
        [{ _tag: "KillingTmuxSession" }],
        () =>
          Promise.resolve({
            operation: "down",
            worktreePath: "/repo/feat",
            sessionName: "wt-feat",
            existed: true,
            status: "killed",
            attempts: { kill: { attempted: true, ok: true, value: null } },
            warnings: [],
          }),
      ),
    );

    await createExecuteDown(makeDeps({ setLifecycle: killed.setLifecycle }))(
      "wt-feat",
      branch,
      "/repo/feat",
      repoPath,
      "proj",
    );

    expect(killed.labels()).toEqual([
      "Preparing Workspace…",
      "Killing tmux session…",
      "Validating Workspace…",
      null,
    ]);

    // --- no session: nothing is killed, so no row for it.
    const absent = trackLifecycle();
    (tuiRuntime.runPromise as Mock).mockImplementation(
      serviceEmitting(workspaceDown, "down", [], () =>
        Promise.resolve({
          operation: "down",
          worktreePath: "/repo/feat",
          sessionName: "wt-feat",
          existed: false,
          status: "absent",
          attempts: { kill: { attempted: false, reason: "session_absent" } },
          warnings: [],
        }),
      ),
    );

    await createExecuteDown(makeDeps({ setLifecycle: absent.setLifecycle }))(
      "wt-feat",
      branch,
      "/repo/feat",
      repoPath,
      "proj",
    );

    expect(absent.labels()).toEqual([
      "Preparing Workspace…",
      "Validating Workspace…",
      null,
    ]);
    expect(absent.labels()).not.toContain("Killing tmux session…");
  });

  // AC-21
  test("a running up/down is inert, presented expanded without details, and validates on success and failure", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");

    // --- Presentation: expanded, but stats/PR/pane detail rows suppressed.
    const repoList = repos();
    const lifecycle: LifecycleState = new Map([
      [
        lifecycleKey(repoPath, branch),
        {
          operation: "up",
          repoPath,
          project: "proj",
          branch,
          phase: { _tag: "CreatingTmuxSession" },
        } satisfies LifecycleEntry,
      ],
    ]);
    const items = buildTreeItems({
      repos: repoList,
      expandedWorktreeKeys: new Set([worktreeKey]),
      lifecycle,
      prData: new Map([
        [
          worktreeKey,
          {
            number: 7,
            title: "Add thing",
            state: "OPEN" as const,
            headRefName: branch,
            rollupState: null,
          },
        ],
      ]),
      panes: new Map([
        [
          "feat",
          [
            {
              paneId: "%1",
              paneIndex: 0,
              command: "vim",
              window: "0",
              zoomed: false,
              active: true,
            },
          ],
        ],
      ]),
      jumpToPane: () => undefined,
    });
    expect(items.some((item) => item.type === "detail")).toBe(false);

    const rows = buildTreeRows({
      items,
      repos: repoList,
      expandedRepos: new Set(["r1"]),
      expandedWorktreeKeys: new Set([worktreeKey]),
      lifecycle,
      maxWidth: 80,
    });
    expect(rows.some((row) => row.kind === "worktree-stats")).toBe(false);
    expect(
      rows.filter((row) => row.kind === "lifecycle-progress"),
    ).toHaveLength(1);

    // --- Actions targeting it are refused through the timed error display.
    const inertDeps = makeDeps({
      treeItems: [{ type: "worktree", repoIndex: 0, worktreeIndex: 0 }],
      filteredRepos: repoList,
      selectedIndex: 0,
      sessions: [{ name: "feat", attached: false }],
      lifecycle,
    });
    createHandleSpaceSwitch(inertDeps)();
    createHandleDownSelectedWorktree(inertDeps)();
    expect(inertDeps.showActionError).toHaveBeenCalledTimes(2);
    expect(inertDeps.setMode).not.toHaveBeenCalled();
    expect(workspaceUp).not.toHaveBeenCalled();

    // --- Both outcomes settle into `Validating Workspace…`.
    const failedUp = trackLifecycle();
    (tuiRuntime.runPromise as Mock).mockRejectedValue(new Error("tmux boom"));
    await createStartWorkspace(
      makeDeps({ setLifecycle: failedUp.setLifecycle }),
    )(target());
    expect(failedUp.labels()).toContain("Validating Workspace…");

    const failedDown = trackLifecycle();
    (tuiRuntime.runPromise as Mock).mockRejectedValue(new Error("kill boom"));
    await createExecuteDown(
      makeDeps({ setLifecycle: failedDown.setLifecycle }),
    )("wt-feat", branch, "/repo/feat", repoPath, "proj");
    expect(failedDown.labels()).toContain("Validating Workspace…");
  });

  // AC-22
  test("finishing up/down removes progress, restores prior expansion, and defers errors and the tmux switch", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");

    const tracker = trackLifecycle();
    let lifecycleSizeAtSwitch = -1;
    const switchSession = vi.fn(async () => {
      lifecycleSizeAtSwitch = tracker.state.size;
      return false; // a failed switch must still report as a plain error
    });
    const deps = makeDeps({
      setLifecycle: tracker.setLifecycle,
      discoverClient: vi.fn().mockResolvedValue({
        type: "single",
        client: { tty: "/dev/pts/0", session: "other" },
      }),
      switchSession,
    });

    (tuiRuntime.runPromise as Mock).mockImplementation(
      serviceEmitting(
        workspaceUp,
        "up",
        [{ _tag: "CreatingTmuxSession" }],
        () =>
          Promise.resolve(
            makeWorkspaceUpResult({
              sessionName: "wt-feat",
              attempts: {
                tmux: {
                  attempted: true,
                  ok: true,
                  value: { _tag: "Created", sessionName: "wt-feat" },
                },
              },
            }),
          ),
      ),
    );

    await createStartWorkspace(deps)(target({ autoSwitch: true }));

    // The progress row is gone.
    expect(tracker.state.size).toBe(0);
    expect(tracker.phases[tracker.phases.length - 1]).toBeNull();

    // Expansion is a presentation override, never a stored write: with the
    // entry gone, effective expansion is exactly the user's own preference
    // again — and nothing in these deps can even write that preference.
    expect(deps).not.toHaveProperty("setExpandedWorktreeKeys");
    for (const stored of [new Set<string>(), new Set([worktreeKey])]) {
      expect(
        isWorktreeEffectivelyExpanded({
          expandedWorktreeKeys: stored,
          lifecycle: tracker.state,
          project: "proj",
          repoPath,
          branch,
        }),
      ).toBe(stored.has(worktreeKey));
    }

    // Validation ran before the switch, and the switch only after teardown.
    const refreshOrder = vi.mocked(deps.refreshAll).mock
      .invocationCallOrder[0] as number;
    const switchOrder = switchSession.mock.invocationCallOrder[0] as number;
    const errorOrder = vi.mocked(deps.showActionError).mock
      .invocationCallOrder[0] as number;
    expect(refreshOrder).toBeLessThan(switchOrder);
    expect(lifecycleSizeAtSwitch).toBe(0);
    // The outcome is reported last of all — after validation and the handoff.
    expect(errorOrder).toBeGreaterThan(switchOrder);
    expect(deps.showActionError).toHaveBeenCalledWith(
      expect.stringContaining("failed to switch client"),
    );

    // --- down: same teardown, and no outcome noise on a clean stop.
    const downTracker = trackLifecycle();
    const downDeps = makeDeps({ setLifecycle: downTracker.setLifecycle });
    (tuiRuntime.runPromise as Mock).mockImplementation(
      serviceEmitting(
        workspaceDown,
        "down",
        [{ _tag: "KillingTmuxSession" }],
        () =>
          Promise.resolve({
            operation: "down",
            worktreePath: "/repo/feat",
            sessionName: "wt-feat",
            existed: true,
            status: "killed",
            attempts: { kill: { attempted: true, ok: true, value: null } },
            warnings: [],
          }),
      ),
    );

    await createExecuteDown(downDeps)(
      "wt-feat",
      branch,
      "/repo/feat",
      repoPath,
      "proj",
    );

    expect(downTracker.state.size).toBe(0);
    expect(downDeps.refreshAll).toHaveBeenCalled();
    expect(downDeps.showActionError).not.toHaveBeenCalled();
  });
});

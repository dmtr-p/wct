import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { commandError } from "../../src/errors";
import {
  type WorkspaceCloseResult,
  WorkspaceService,
  type WorkspaceUpResult,
} from "../../src/services/workspace-service";
import type { SessionActionDeps } from "../../src/tui/hooks/useSessionActions";
import {
  createExecuteClose,
  createExecuteDown,
  createHandleDownSelectedWorktree,
  createHandleSpaceSwitch,
  createHandleStartResult,
  createSwitchClientAway,
} from "../../src/tui/hooks/useSessionActions";
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
    setSelectedIndex: vi.fn(),
    setMode: vi.fn(),
    setPendingActions: vi.fn((fn) => {
      if (typeof fn === "function") fn(new Map());
    }),
    showActionError: vi.fn(),
    clearActionError: vi.fn(),
    switchSession: vi.fn().mockResolvedValue(true),
    detachClient: vi.fn().mockResolvedValue(true),
    discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
    refreshSessions: vi.fn().mockResolvedValue([]),
    refreshAll: vi.fn().mockResolvedValue(undefined),
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

describe("createHandleStartResult", () => {
  test("auto-switches when tmux succeeded and single client", async () => {
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({
        type: "single",
        client: { tty: "/dev/pts/0", session: "other" },
      }),
      switchSession: vi.fn().mockResolvedValue(true),
    });
    const handleStart = createHandleStartResult(deps);

    const result = makeStartResult({
      attempts: {
        tmux: {
          attempted: true,
          ok: true,
          value: { _tag: "Created", sessionName: "wt-feat" },
        },
      },
    });

    await handleStart(result, true);
    expect(deps.switchSession).toHaveBeenCalledWith("wt-feat", {
      tty: "/dev/pts/0",
      session: "other",
    });
    expect(deps.refreshSessions).toHaveBeenCalled();
  });

  test("shows error when switch fails", async () => {
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({
        type: "single",
        client: { tty: "/dev/pts/0", session: "other" },
      }),
      switchSession: vi.fn().mockResolvedValue(false),
    });
    const handleStart = createHandleStartResult(deps);

    const result = makeStartResult({
      attempts: {
        tmux: {
          attempted: true,
          ok: true,
          value: { _tag: "Created", sessionName: "wt-feat" },
        },
      },
    });

    await handleStart(result, true);
    expect(deps.showActionError).toHaveBeenCalledWith(
      expect.stringContaining("failed to switch"),
    );
  });

  test("does not switch when autoSwitch is false", async () => {
    const deps = makeDeps();
    const handleStart = createHandleStartResult(deps);

    const result = makeStartResult({
      attempts: {
        tmux: {
          attempted: true,
          ok: true,
          value: { _tag: "Created", sessionName: "wt-feat" },
        },
      },
    });

    await handleStart(result, false);
    expect(deps.switchSession).not.toHaveBeenCalled();
    expect(deps.refreshAll).toHaveBeenCalled();
  });

  test("calls refreshAll and shows action message when present", async () => {
    const deps = makeDeps();
    const handleStart = createHandleStartResult(deps);

    const result = makeStartResult({
      attempts: {
        tmux: {
          attempted: true,
          ok: false,
          error: commandError("unexpected_error", "tmux failed"),
        },
      },
    });

    await handleStart(result, false);
    expect(deps.refreshAll).toHaveBeenCalled();
    expect(deps.showActionError).toHaveBeenCalledWith("tmux failed");
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

  test("starts new session when none exists and sets pending action", async () => {
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
    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
      sessions: [],
      setPendingActions,
    });
    const handleSpace = createHandleSpaceSwitch(deps);

    handleSpace();

    expect(deps.clearActionError).toHaveBeenCalled();
    expect(setPendingActions).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(WorkspaceService.use).toHaveBeenCalled();
      expect(workspaceUp).toHaveBeenCalledWith({ path: "/repo/feat" });
      expect(tuiRuntime.runPromise).toHaveBeenCalledWith(
        "mock-workspace-effect",
      );
    });
    await vi.waitFor(() => {
      expect(pendingActions.size).toBe(0);
      expect(setPendingActions).toHaveBeenCalledTimes(2);
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
    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
      sessions: [],
      setPendingActions,
    });
    const handleSpace = createHandleSpaceSwitch(deps);

    handleSpace();

    // Wait for the async error handling to complete
    await vi.waitFor(() => {
      expect(deps.showActionError).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(pendingActions.size).toBe(0);
      expect(setPendingActions).toHaveBeenCalledTimes(2);
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
    expect(deps.setPendingActions).not.toHaveBeenCalled();
  });

  test("uses WorkspaceService.close, refreshes, and clears pending after success", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValue(
      makeWorkspaceCloseResult(),
    );

    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
      setPendingActions,
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
    });
    expect(tuiRuntime.runPromise).toHaveBeenCalledWith("mock-workspace-effect");
    expect(deps.setPendingActions).toHaveBeenCalled();
    expect(deps.refreshAll).toHaveBeenCalled();
    expect(deps.showActionError).not.toHaveBeenCalled();
    expect(pendingActions.size).toBe(0);
    expect(setPendingActions).toHaveBeenCalledTimes(2);
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
    });
  });

  test("blocked close enters force-confirm mode, refreshes, and clears pending", async () => {
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

    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
      setPendingActions,
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
    expect(deps.refreshAll).toHaveBeenCalled();
    expect(pendingActions.size).toBe(0);
    expect(setPendingActions).toHaveBeenCalledTimes(2);
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
    });
    expect(deps.refreshAll).toHaveBeenCalled();
  });

  test("surfaces WorkspaceService.close tmux kill failure and clears pending", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockRejectedValue(
      commandError("tmux_error", "kill failed"),
    );

    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
      setPendingActions,
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
    });
    expect(deps.showActionError).toHaveBeenCalledWith("kill failed");
    expect(deps.refreshAll).toHaveBeenCalled();
    expect(pendingActions.size).toBe(0);
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

    await executeDown("target-session", "feat", "/tmp/wt", "proj/feat");

    expect(deps.showActionError).toHaveBeenCalledWith(
      expect.stringContaining("could not be moved away"),
    );
    expect(deps.setPendingActions).not.toHaveBeenCalled();
  });

  test("uses WorkspaceService.down, refreshes, and clears pending after kill success", async () => {
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

    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
      setPendingActions,
    });
    const executeDown = createExecuteDown(deps);

    await executeDown("wt", "feat", "/tmp/wt", "proj/feat");

    expect(WorkspaceService.use).toHaveBeenCalled();
    expect(workspaceDown).toHaveBeenCalledWith({ path: "/tmp/wt" });
    expect(tuiRuntime.runPromise).toHaveBeenCalledWith("mock-workspace-effect");
    expect(deps.refreshAll).toHaveBeenCalled();
    expect(deps.showActionError).not.toHaveBeenCalled();
    expect(pendingActions.size).toBe(0);
    expect(setPendingActions).toHaveBeenCalledTimes(2);
  });

  test("treats absent-session down as informational success and clears pending", async () => {
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

    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
      setPendingActions,
    });
    const executeDown = createExecuteDown(deps);

    await executeDown("wt", "feat", "/tmp/wt", "proj/feat");

    expect(deps.refreshAll).toHaveBeenCalled();
    expect(deps.showActionError).not.toHaveBeenCalled();
    expect(pendingActions.size).toBe(0);
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

    await executeDown("wt", "feat", "/tmp/wt", "proj/feat");

    expect(workspaceDown).toHaveBeenCalledWith({ path: "/tmp/wt" });
    expect(deps.showActionError).not.toHaveBeenCalled();
    expect(deps.refreshAll).toHaveBeenCalled();
  });

  test("surfaces WorkspaceService.down failure and clears pending", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockRejectedValue(
      commandError("tmux_error", "kill failed"),
    );

    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const deps = makeDeps({
      discoverClient: vi.fn().mockResolvedValue({ type: "none" }),
      refreshSessions: vi.fn().mockResolvedValue([]),
      setPendingActions,
    });
    const executeDown = createExecuteDown(deps);

    await executeDown("wt", "feat", "/tmp/wt", "proj/feat");

    expect(deps.showActionError).toHaveBeenCalledWith("kill failed");
    expect(deps.refreshAll).toHaveBeenCalled();
    expect(pendingActions.size).toBe(0);
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
      Mode.ConfirmDown("feat", "feat", "/repo/feat", "proj/feat"),
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

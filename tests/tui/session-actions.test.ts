import { type Mock, beforeEach, describe, expect, test, vi } from "vitest";
import type { StartWorktreeSessionResult } from "../../src/commands/worktree-session";
import type { SessionActionDeps } from "../../src/tui/hooks/useSessionActions";
import {
  createExecuteClose,
  createHandleDownSelectedWorktree,
  createHandleSpaceSwitch,
  createHandleStartResult,
  createSwitchClientAway,
} from "../../src/tui/hooks/useSessionActions";
import { Mode, type TreeItem, pendingKey } from "../../src/tui/types";

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../src/commands/worktree-session", () => ({
  startWorktreeSession: vi.fn(() => "mock-effect"),
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
  overrides: Partial<StartWorktreeSessionResult> = {},
): StartWorktreeSessionResult {
  return {
    worktreePath: "/tmp/wt",
    mainRepoPath: "/tmp/repo",
    branch: "feat",
    sessionName: "wt-feat",
    projectName: "proj",
    env: {} as StartWorktreeSessionResult["env"],
    tmux: { attempted: false },
    ide: { attempted: false },
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
      tmux: {
        attempted: true,
        ok: true,
        value: { _tag: "Created", sessionName: "wt-feat" },
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
      tmux: {
        attempted: true,
        ok: true,
        value: { _tag: "Created", sessionName: "wt-feat" },
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
      tmux: {
        attempted: true,
        ok: true,
        value: { _tag: "Created", sessionName: "wt-feat" },
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
      tmux: {
        attempted: true,
        ok: false,
        error: {
          _tag: "WctCommandError",
          message: "tmux failed",
          code: "unexpected_error",
        } as any,
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
    const { startWorktreeSession } = await import(
      "../../src/commands/worktree-session"
    );

    const startResult = makeStartResult();
    (tuiRuntime.runPromise as Mock).mockResolvedValue(startResult);

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
    const setPendingActions = vi.fn((fn) => {
      if (typeof fn === "function") fn(new Map());
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
  });
});

describe("createExecuteClose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls switchClientAway first and aborts on failure", async () => {
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
  });

  test("sets pending action and removes on completion", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock)
      .mockResolvedValueOnce(undefined) // kill session
      .mockResolvedValueOnce({ _tag: "Removed" }); // remove worktree

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
    expect(deps.setPendingActions).toHaveBeenCalled();
    expect(deps.refreshAll).toHaveBeenCalled();
  });

  test("transitions to ConfirmCloseForce on BlockedByChanges", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ _tag: "BlockedByChanges" });

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

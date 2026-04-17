import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type { ModalActionDeps } from "../../src/tui/hooks/useModalActions";
import {
  createHandleOpen,
  createHandleUpSubmit,
  createPrepareOpenModal,
  createPrepareUpModal,
} from "../../src/tui/hooks/useModalActions";
import {
  Mode,
  type PRInfo,
  type TreeItem,
  pendingKey,
} from "../../src/tui/types";

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../src/commands/worktree-session", () => ({
  startWorktreeSession: vi.fn(() => "mock-effect"),
}));

function makeDeps(overrides: Partial<ModalActionDeps> = {}): ModalActionDeps {
  return {
    treeItems: [],
    filteredRepos: [],
    selectedIndex: 0,
    mode: Mode.Navigate,
    prData: new Map(),
    openModalRepoProject: "",
    openModalRepoPath: "",
    setMode: vi.fn(),
    setSelectedIndex: vi.fn(),
    setPendingActions: vi.fn((fn) => {
      if (typeof fn === "function") fn(new Map());
    }),
    setOpenModalBase: vi.fn(),
    setOpenModalProfiles: vi.fn(),
    setOpenModalRepoProject: vi.fn(),
    setOpenModalRepoPath: vi.fn(),
    setOpenModalPRList: vi.fn(),
    showActionError: vi.fn(),
    clearActionError: vi.fn(),
    handleStartResult: vi.fn().mockResolvedValue(undefined),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    upModalReturnModeRef: { current: Mode.Navigate },
    upModalReturnSelectedIndexRef: { current: 0 },
    ...overrides,
  };
}

describe("createPrepareOpenModal", () => {
  test("extracts base, profiles, project, repoPath from selected worktree item", () => {
    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const repos = [
      {
        id: "r1",
        project: "myproj",
        repoPath: "/home/user/myproj",
        profileNames: ["dev", "ci"],
        worktrees: [
          {
            branch: "feat-a",
            path: "/home/user/myproj/feat-a",
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
    });
    const prepare = createPrepareOpenModal(deps);

    prepare();

    expect(deps.setOpenModalBase).toHaveBeenCalledWith("feat-a");
    expect(deps.setOpenModalProfiles).toHaveBeenCalledWith(["dev", "ci"]);
    expect(deps.setOpenModalRepoProject).toHaveBeenCalledWith("myproj");
    expect(deps.setOpenModalRepoPath).toHaveBeenCalledWith("/home/user/myproj");
    expect(deps.setMode).toHaveBeenCalledWith(Mode.OpenModal);
  });

  test("filters PRs by project prefix", () => {
    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const repos = [
      {
        id: "r1",
        project: "myproj",
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
    const matchingPR: PRInfo = {
      number: 42,
      title: "Fix bug",
      state: "OPEN",
      headRefName: "fix-bug",
      checks: [],
    };
    const otherPR: PRInfo = {
      number: 99,
      title: "Other",
      state: "OPEN",
      headRefName: "other",
      checks: [],
    };
    const prData = new Map<string, PRInfo>([
      ["myproj/fix-bug", matchingPR],
      ["otherproj/other", otherPR],
    ]);
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
      prData,
    });
    const prepare = createPrepareOpenModal(deps);

    prepare();

    expect(deps.setOpenModalPRList).toHaveBeenCalledWith([matchingPR]);
  });

  test("sets undefined base when selected item is a repo header", () => {
    const items: TreeItem[] = [{ type: "repo", repoIndex: 0 }];
    const repos = [
      {
        id: "r1",
        project: "myproj",
        repoPath: "/repo",
        profileNames: ["dev"],
        worktrees: [],
      },
    ];
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
    });
    const prepare = createPrepareOpenModal(deps);

    prepare();

    expect(deps.setOpenModalBase).toHaveBeenCalledWith(undefined);
    expect(deps.setOpenModalProfiles).toHaveBeenCalledWith(["dev"]);
  });
});

describe("createHandleOpen", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Bun.spawn is writable but not configurable, so assign directly
    (Bun as any).spawn = originalSpawn;
    vi.useRealTimers();
  });

  test("sets pending action and clears on success after refreshAll", async () => {
    let resolveExited: (code: number) => void;
    const exitedPromise = new Promise<number>((r) => {
      resolveExited = r;
    });
    (Bun as any).spawn = vi.fn().mockReturnValue({ exited: exitedPromise });

    const setPendingActions = vi.fn((fn) => {
      if (typeof fn === "function") fn(new Map());
    });
    const refreshAll = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      setPendingActions,
      refreshAll,
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      prompt: "",
      existing: false,
      noIde: false,
      noAttach: false,
    });

    expect(deps.setMode).toHaveBeenCalledWith(Mode.Navigate);
    expect(setPendingActions).toHaveBeenCalled();

    // Simulate success
    resolveExited!(0);
    await vi.waitFor(() => {
      expect(refreshAll).toHaveBeenCalled();
    });
  });

  test("clears pending action after 5s delay on error", async () => {
    let resolveExited: (code: number) => void;
    const exitedPromise = new Promise<number>((r) => {
      resolveExited = r;
    });
    (Bun as any).spawn = vi.fn().mockReturnValue({ exited: exitedPromise });

    const setPendingActions = vi.fn((fn) => {
      if (typeof fn === "function") fn(new Map());
    });
    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      setPendingActions,
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      prompt: "",
      existing: false,
      noIde: false,
      noAttach: false,
    });

    // Initial setPendingActions call to set the pending action
    const initialCallCount = setPendingActions.mock.calls.length;

    // Simulate failure
    resolveExited!(1);

    // Wait for the .then to execute
    await vi.waitFor(() => {
      // setTimeout should be scheduled now
    });

    // Advance timer by 5s
    await vi.advanceTimersByTimeAsync(5000);

    // Should have had another call to clear
    expect(setPendingActions.mock.calls.length).toBeGreaterThan(
      initialCallCount,
    );
  });
});

describe("createPrepareUpModal", () => {
  test("resolves worktree and saves refs before setting UpModal mode", () => {
    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const repos = [
      {
        id: "r1",
        project: "proj",
        repoPath: "/repo",
        profileNames: ["dev"],
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
      upModalReturnModeRef: returnModeRef,
      upModalReturnSelectedIndexRef: returnIndexRef,
    });
    const prepare = createPrepareUpModal(deps);

    prepare();

    expect(returnIndexRef.current).toBe(0);
    expect(returnModeRef.current).toEqual(Mode.Navigate);
    expect(deps.setMode).toHaveBeenCalledWith(
      Mode.UpModal("/repo/feat", pendingKey("proj", "feat"), ["dev"]),
    );
  });

  test("no-op when selected item is a repo header", () => {
    const items: TreeItem[] = [{ type: "repo", repoIndex: 0 }];
    const deps = makeDeps({
      treeItems: items,
      selectedIndex: 0,
    });
    const prepare = createPrepareUpModal(deps);

    prepare();
    expect(deps.setMode).not.toHaveBeenCalled();
  });

  test("saves Expanded mode in return ref when in Expanded mode", () => {
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
      upModalReturnModeRef: returnModeRef,
    });
    const prepare = createPrepareUpModal(deps);

    prepare();
    expect(returnModeRef.current).toEqual(Mode.Expanded(worktreeKey));
  });
});

describe("createHandleUpSubmit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("restores return mode and index, then delegates to handleStartResult", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    const startResult = {
      worktreePath: "/repo/feat",
      mainRepoPath: "/repo",
      branch: "feat",
      sessionName: "feat",
      projectName: "proj",
      env: {},
      tmux: { attempted: false },
      ide: { attempted: false },
    };
    (tuiRuntime.runPromise as Mock).mockResolvedValue(startResult);

    const returnModeRef = { current: Mode.Navigate };
    const returnIndexRef = { current: 3 };
    const handleStartResult = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      mode: Mode.UpModal("/repo/feat", "proj/feat", ["dev"]),
      upModalReturnModeRef: returnModeRef,
      upModalReturnSelectedIndexRef: returnIndexRef,
      handleStartResult,
    });
    const handleUp = createHandleUpSubmit(deps);

    handleUp({ profile: "dev", noIde: false, autoSwitch: true });

    expect(deps.clearActionError).toHaveBeenCalled();
    expect(deps.setSelectedIndex).toHaveBeenCalledWith(3);
    expect(deps.setMode).toHaveBeenCalledWith(Mode.Navigate);
    expect(deps.setPendingActions).toHaveBeenCalled();

    // Wait for the async operation
    await vi.waitFor(() => {
      expect(handleStartResult).toHaveBeenCalledWith(startResult, true);
    });
  });

  test("shows error and refreshes on failure", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockRejectedValue(
      new Error("session fail"),
    );

    const deps = makeDeps({
      mode: Mode.UpModal("/repo/feat", "proj/feat", []),
      upModalReturnModeRef: { current: Mode.Navigate },
      upModalReturnSelectedIndexRef: { current: 0 },
    });
    const handleUp = createHandleUpSubmit(deps);

    handleUp({ profile: undefined, noIde: false, autoSwitch: false });

    await vi.waitFor(() => {
      expect(deps.showActionError).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(deps.refreshAll).toHaveBeenCalled();
    });
  });

  test("no-op when mode is not UpModal", () => {
    const deps = makeDeps({ mode: Mode.Navigate });
    const handleUp = createHandleUpSubmit(deps);

    handleUp({ profile: undefined, noIde: false, autoSwitch: false });

    expect(deps.clearActionError).not.toHaveBeenCalled();
    expect(deps.setMode).not.toHaveBeenCalled();
  });
});

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from "vitest";
import type { ModalActionDeps } from "../../src/tui/hooks/useModalActions";
import {
  createHandleAddProject,
  createHandleOpen,
  createHandleUpSubmit,
  createPrepareAddProjectModal,
  createPrepareOpenModal,
  createPrepareUpModal,
} from "../../src/tui/hooks/useModalActions";
import type { TmuxClientDiscovery } from "../../src/tui/hooks/useTmux";
import { Mode, pendingKey, type TreeItem } from "../../src/tui/types";

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn().mockResolvedValue(undefined),
  },
  runTuiSilentPromise: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/commands/worktree-session", () => ({
  startWorktreeSession: vi.fn(() => "mock-effect"),
}));

vi.mock("../../src/commands/open", () => ({
  resolveOpenOptions: vi.fn(() => "resolve-open-effect"),
  openWorktree: vi.fn(() => "open-worktree-effect"),
}));

function makeDeps(overrides: Partial<ModalActionDeps> = {}): ModalActionDeps {
  return {
    treeItems: [],
    filteredRepos: [],
    selectedIndex: 0,
    mode: Mode.Navigate,
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
    showActionError: vi.fn(),
    clearActionError: vi.fn(),
    switchSession: vi.fn().mockResolvedValue(true),
    discoverClient: vi.fn().mockResolvedValue({ type: "none" } as const),
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
        ideDefaults: { baseNoIde: true, profileNoIde: {} },
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

  test("sets undefined base when selected item is a repo header", () => {
    const items: TreeItem[] = [{ type: "repo", repoIndex: 0 }];
    const repos = [
      {
        id: "r1",
        project: "myproj",
        repoPath: "/repo",
        profileNames: ["dev"],
        ideDefaults: { baseNoIde: true, profileNoIde: {} },
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("runs open in process detached, refreshes, and clears pending on success", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");
    const { openWorktree, resolveOpenOptions } = await import(
      "../../src/commands/open"
    );

    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const refreshAll = vi.fn().mockResolvedValue(undefined);
    const resolvedOptions = {
      branch: "feat",
      existing: false,
      base: "main",
      cwd: "/repo",
      noIde: true,
      profile: "dev",
      prompt: "ship it",
    };
    const openResult = {
      worktreePath: "/repo/feat",
      branch: "feat",
      sessionName: "feat",
      projectName: "proj",
      created: true,
      tmuxSessionStarted: true,
      warnings: [],
    };
    (runTuiSilentPromise as Mock)
      .mockResolvedValueOnce(resolvedOptions)
      .mockResolvedValueOnce(openResult);
    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      setPendingActions,
      refreshAll,
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: "main",
      pr: "",
      profile: "dev",
      prompt: "ship it",
      existing: false,
      noIde: true,
      noAttach: true,
    });

    expect(deps.setMode).toHaveBeenCalledWith(Mode.Navigate);
    expect(resolveOpenOptions).toHaveBeenCalledWith({
      branch: "feat",
      base: "main",
      cwd: "/repo",
      pr: "",
      profile: "dev",
      prompt: "ship it",
      existing: false,
      noIde: true,
    });
    expect(runTuiSilentPromise).toHaveBeenNthCalledWith(
      1,
      "resolve-open-effect",
    );
    expect(pendingActions.has(pendingKey("proj", "feat"))).toBe(true);

    await vi.waitFor(() => {
      expect(openWorktree).toHaveBeenCalledWith(resolvedOptions);
      expect(runTuiSilentPromise).toHaveBeenNthCalledWith(
        2,
        "open-worktree-effect",
      );
      expect(refreshAll).toHaveBeenCalled();
    });
    expect(deps.showActionError).not.toHaveBeenCalled();
    expect(pendingActions.size).toBe(0);
    expect(setPendingActions).toHaveBeenCalledTimes(2);
  });

  test("shows the effect error, skips refresh, and clears pending without waiting on process exit", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");
    const { openWorktree, resolveOpenOptions } = await import(
      "../../src/commands/open"
    );

    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const resolvedOptions = {
      branch: "feat",
      existing: false,
      cwd: "/repo",
    };
    (runTuiSilentPromise as Mock)
      .mockResolvedValueOnce(resolvedOptions)
      .mockRejectedValueOnce(new Error("open failed"));
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
      noAttach: true,
    });

    await vi.waitFor(() => {
      expect(resolveOpenOptions).toHaveBeenCalledWith({
        branch: "feat",
        base: "",
        cwd: "/repo",
        pr: "",
        profile: "",
        prompt: "",
        existing: false,
        noIde: false,
      });
      expect(openWorktree).toHaveBeenCalledWith(resolvedOptions);
      expect(deps.showActionError).toHaveBeenCalledWith("open failed");
    });
    expect(runTuiSilentPromise).toHaveBeenCalledTimes(2);
    expect(deps.refreshAll).not.toHaveBeenCalled();
    expect(pendingActions.size).toBe(0);
    expect(setPendingActions).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  test("omits branch when opening from a PR", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");
    const { openWorktree, resolveOpenOptions } = await import(
      "../../src/commands/open"
    );

    const resolvedOptions = {
      branch: "pr-branch",
      existing: false,
      base: "origin/pr-branch",
      cwd: "/repo",
      pr: "123",
    };
    const openResult = {
      worktreePath: "/repo/pr-branch",
      branch: "pr-branch",
      sessionName: "pr-branch",
      projectName: "proj",
      created: true,
      tmuxSessionStarted: true,
      warnings: [],
    };
    (runTuiSilentPromise as Mock)
      .mockResolvedValueOnce(resolvedOptions)
      .mockResolvedValueOnce(openResult);

    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      refreshAll: vi.fn().mockResolvedValue(undefined),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "pr-branch",
      pr: "123",
      profile: undefined,
      prompt: undefined,
      existing: false,
      noIde: false,
      noAttach: true,
    });

    expect(resolveOpenOptions).toHaveBeenCalledWith({
      branch: undefined,
      base: undefined,
      cwd: "/repo",
      pr: "123",
      profile: undefined,
      prompt: undefined,
      existing: false,
      noIde: false,
    });

    await vi.waitFor(() => {
      expect(openWorktree).toHaveBeenCalledWith(resolvedOptions);
      expect(deps.refreshAll).toHaveBeenCalled();
    });
  });

  test("shows structured warnings returned by openWorktree after a successful open", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");

    (runTuiSilentPromise as Mock)
      .mockResolvedValueOnce({
        branch: "feat",
        existing: false,
        cwd: "/repo",
      })
      .mockResolvedValueOnce({
        worktreePath: "/repo/feat",
        branch: "feat",
        sessionName: "feat",
        projectName: "proj",
        created: true,
        tmuxSessionStarted: true,
        warnings: ["Optional setup failed: bootstrap: missing tool"],
      });

    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      refreshAll: vi.fn().mockResolvedValue(undefined),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      prompt: undefined,
      existing: false,
      noIde: false,
      noAttach: true,
    });

    await vi.waitFor(() => {
      expect(deps.refreshAll).toHaveBeenCalled();
      expect(deps.showActionError).toHaveBeenCalledWith(
        "Optional setup failed: bootstrap: missing tool",
      );
    });
  });

  test("handles refresh failures separately from open failures", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");

    (runTuiSilentPromise as Mock)
      .mockResolvedValueOnce({
        branch: "feat",
        existing: false,
        cwd: "/repo",
      })
      .mockResolvedValueOnce({
        worktreePath: "/repo/feat",
        branch: "feat",
        sessionName: "feat",
        projectName: "proj",
        created: true,
        tmuxSessionStarted: true,
        warnings: [],
      });

    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      refreshAll: vi.fn().mockRejectedValue(new Error("refresh blew up")),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      prompt: undefined,
      existing: false,
      noIde: false,
      noAttach: true,
    });

    await vi.waitFor(() => {
      expect(deps.showActionError).toHaveBeenCalledWith(
        "Refresh failed after open: refresh blew up",
      );
    });
  });

  test("switches the detected client after open when noAttach is disabled", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");
    const { openWorktree, resolveOpenOptions } = await import(
      "../../src/commands/open"
    );

    const discoverClient = vi
      .fn<() => Promise<TmuxClientDiscovery>>()
      .mockResolvedValue({
        type: "single",
        client: { tty: "/dev/pts/1", session: "main" },
      });
    const switchSession = vi.fn().mockResolvedValue(true);
    (runTuiSilentPromise as Mock)
      .mockResolvedValueOnce({
        branch: "feat",
        existing: false,
        cwd: "/repo",
      })
      .mockResolvedValueOnce({
        worktreePath: "/repo/feat",
        branch: "feat",
        sessionName: "feat",
        projectName: "proj",
        created: true,
        tmuxSessionStarted: true,
        warnings: [],
      });

    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      discoverClient,
      switchSession,
      refreshAll: vi.fn().mockResolvedValue(undefined),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      prompt: undefined,
      existing: false,
      noIde: false,
      noAttach: false,
    });

    expect(resolveOpenOptions).toHaveBeenCalledWith({
      branch: "feat",
      base: undefined,
      cwd: "/repo",
      pr: undefined,
      profile: undefined,
      prompt: undefined,
      existing: false,
      noIde: false,
    });
    await vi.waitFor(() => {
      expect(openWorktree).toHaveBeenCalled();
      expect(discoverClient).toHaveBeenCalled();
      expect(switchSession).toHaveBeenCalledWith("feat", {
        tty: "/dev/pts/1",
        session: "main",
      });
    });
  });

  test("shows the existing tmux warning when attach was requested but no client is found", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");

    const discoverClient = vi
      .fn<() => Promise<TmuxClientDiscovery>>()
      .mockResolvedValue({ type: "none" });
    (runTuiSilentPromise as Mock)
      .mockResolvedValueOnce({
        branch: "feat",
        existing: false,
        cwd: "/repo",
      })
      .mockResolvedValueOnce({
        worktreePath: "/repo/feat",
        branch: "feat",
        sessionName: "feat",
        projectName: "proj",
        created: true,
        tmuxSessionStarted: true,
        warnings: [],
      });

    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      discoverClient,
      refreshAll: vi.fn().mockResolvedValue(undefined),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      prompt: undefined,
      existing: false,
      noIde: false,
      noAttach: false,
    });

    await vi.waitFor(() => {
      expect(deps.showActionError).toHaveBeenCalledWith(
        "No tmux client found — start tmux in the other pane",
      );
    });
  });

  test("shows the existing tmux warning when attach was requested but client discovery errors", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");

    const discoverClient = vi
      .fn<() => Promise<TmuxClientDiscovery>>()
      .mockResolvedValue({ type: "error" });
    (runTuiSilentPromise as Mock)
      .mockResolvedValueOnce({
        branch: "feat",
        existing: false,
        cwd: "/repo",
      })
      .mockResolvedValueOnce({
        worktreePath: "/repo/feat",
        branch: "feat",
        sessionName: "feat",
        projectName: "proj",
        created: true,
        tmuxSessionStarted: true,
        warnings: [],
      });

    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      discoverClient,
      refreshAll: vi.fn().mockResolvedValue(undefined),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      prompt: undefined,
      existing: false,
      noIde: false,
      noAttach: false,
    });

    await vi.waitFor(() => {
      expect(deps.showActionError).toHaveBeenCalledWith(
        "Opened session 'feat' but failed to query tmux clients to switch",
      );
    });
  });

  test("shows an error when attach was requested but multiple tmux clients are attached", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");

    const discoverClient = vi
      .fn<() => Promise<TmuxClientDiscovery>>()
      .mockResolvedValue({ type: "multiple" });
    (runTuiSilentPromise as Mock)
      .mockResolvedValueOnce({
        branch: "feat",
        existing: false,
        cwd: "/repo",
      })
      .mockResolvedValueOnce({
        worktreePath: "/repo/feat",
        branch: "feat",
        sessionName: "feat",
        projectName: "proj",
        created: true,
        tmuxSessionStarted: true,
        warnings: [],
      });

    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      discoverClient,
      refreshAll: vi.fn().mockResolvedValue(undefined),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      prompt: undefined,
      existing: false,
      noIde: false,
      noAttach: false,
    });

    await vi.waitFor(() => {
      expect(deps.showActionError).toHaveBeenCalledWith(
        "Cannot switch tmux client after open because multiple tmux clients are attached",
      );
    });
  });

  test("does not switch the client after open when noAttach is enabled", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");

    const discoverClient = vi.fn();
    const switchSession = vi.fn();
    (runTuiSilentPromise as Mock)
      .mockResolvedValueOnce({
        branch: "feat",
        existing: false,
        cwd: "/repo",
      })
      .mockResolvedValueOnce({
        worktreePath: "/repo/feat",
        branch: "feat",
        sessionName: "feat",
        projectName: "proj",
        created: true,
        tmuxSessionStarted: true,
        warnings: [],
      });

    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      discoverClient,
      switchSession,
      refreshAll: vi.fn().mockResolvedValue(undefined),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      prompt: undefined,
      existing: false,
      noIde: false,
      noAttach: true,
    });

    await vi.waitFor(() => {
      expect(deps.refreshAll).toHaveBeenCalled();
    });
    expect(discoverClient).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
  });

  test("skips client discovery when open did not start tmux", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");
    const discoverClient = vi.fn();

    (runTuiSilentPromise as Mock)
      .mockResolvedValueOnce({
        branch: "feat",
        existing: false,
        cwd: "/repo",
      })
      .mockResolvedValueOnce({
        worktreePath: "/repo/feat",
        branch: "feat",
        sessionName: "feat",
        projectName: "proj",
        created: true,
        tmuxSessionStarted: false,
        warnings: [],
      });

    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      discoverClient,
      refreshAll: vi.fn().mockResolvedValue(undefined),
    });

    createHandleOpen(deps)({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      prompt: undefined,
      existing: false,
      noIde: false,
      noAttach: false,
    });

    await vi.waitFor(() => {
      expect(deps.refreshAll).toHaveBeenCalled();
    });
    expect(discoverClient).not.toHaveBeenCalled();
    expect(deps.showActionError).not.toHaveBeenCalledWith(
      expect.stringContaining("tmux client"),
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
        ideDefaults: { baseNoIde: true, profileNoIde: {} },
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
        ideDefaults: { baseNoIde: true, profileNoIde: {} },
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

describe("createPrepareAddProjectModal", () => {
  test("sets mode to AddProjectModal", () => {
    const deps = makeDeps();
    const prepare = createPrepareAddProjectModal(deps);
    prepare();
    expect(deps.setMode).toHaveBeenCalledWith(Mode.AddProjectModal);
  });
});

describe("createHandleAddProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls register and refreshes on success", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");
    (runTuiSilentPromise as Mock).mockResolvedValueOnce({
      id: "1",
      repoPath: "/home/user/myproj",
      project: "myproj",
    });

    const deps = makeDeps({
      refreshAll: vi.fn().mockResolvedValue(undefined),
    });
    const handle = createHandleAddProject(deps);

    handle({
      path: "/home/user/myproj",
      name: "myproj",
      nameManuallyEdited: false,
    });

    expect(deps.setMode).toHaveBeenCalledWith(Mode.Navigate);

    await vi.waitFor(() => {
      expect(runTuiSilentPromise).toHaveBeenCalled();
      expect(deps.refreshAll).toHaveBeenCalled();
    });
  });

  test("shows error on failure", async () => {
    const { runTuiSilentPromise } = await import("../../src/tui/runtime");
    (runTuiSilentPromise as Mock).mockRejectedValueOnce(
      new Error("already registered"),
    );

    const deps = makeDeps();
    const handle = createHandleAddProject(deps);

    handle({ path: "/repo", name: "proj", nameManuallyEdited: false });

    expect(deps.setMode).toHaveBeenCalledWith(Mode.Navigate);

    await vi.waitFor(() => {
      expect(deps.showActionError).toHaveBeenCalledWith("already registered");
    });
  });
});

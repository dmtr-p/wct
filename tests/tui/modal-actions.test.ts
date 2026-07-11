import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from "vitest";
import { WorkspaceService } from "../../src/services/workspace-service";
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

const workspaceOpen = vi.hoisted(() => vi.fn(() => "mock-open-effect"));
const workspaceUp = vi.hoisted(() => vi.fn(() => "mock-workspace-effect"));
const registerProjectMock = vi.hoisted(() =>
  vi.fn(() => "register-project-effect"),
);

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn().mockResolvedValue(undefined),
  },
  runTuiSilentPromise: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/workspace-service", () => ({
  WorkspaceService: {
    use: vi.fn((f) => f({ open: workspaceOpen, up: workspaceUp })),
  },
}));

vi.mock("../../src/services/project-registration", () => ({
  registerProject: registerProjectMock,
}));

const defaultIdeDefaults = { baseNoIde: true, profileNoIde: {} };

function makeOpenResult(overrides: Record<string, unknown> = {}) {
  return {
    operation: "open" as const,
    worktreePath: "/repo/feat",
    mainRepoPath: "/repo",
    branch: "feat",
    sessionName: "feat",
    projectName: "proj",
    created: true,
    env: {},
    warnings: [],
    attempts: {
      worktree: { attempted: true, ok: true, value: {} },
      vscode: { attempted: false, reason: "not_configured" },
      copy: { attempted: false, reason: "not_configured" },
      setup: { attempted: false, reason: "not_configured" },
      tmux: { attempted: true, ok: true, value: { _tag: "Created" } },
      ide: { attempted: false, reason: "disabled" },
    },
    ...overrides,
  };
}

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
    setOpenModalIdeDefaults: vi.fn(),
    showActionError: vi.fn(),
    clearActionError: vi.fn(),
    switchSession: vi.fn().mockResolvedValue(true),
    discoverClient: vi.fn().mockResolvedValue({ type: "none" } as const),
    handleStartResult: vi.fn().mockResolvedValue(undefined),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    upModalReturnModeRef: { current: Mode.Navigate },
    modalReturnModeRef: { current: Mode.Navigate },
    upModalReturnSelectedIndexRef: { current: 0 },
    ...overrides,
  };
}

describe("createPrepareOpenModal", () => {
  test("remembers Expanded mode for modal return", () => {
    const expanded = Mode.Expanded("proj/feat");
    const returnModeRef = { current: Mode.Navigate };
    const deps = makeDeps({
      mode: expanded,
      modalReturnModeRef: returnModeRef,
    });

    createPrepareOpenModal(deps)();

    expect(returnModeRef.current).toEqual(expanded);
  });

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
        ideDefaults: defaultIdeDefaults,
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
    expect(deps.setOpenModalIdeDefaults).toHaveBeenCalledWith(
      defaultIdeDefaults,
    );
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
        ideDefaults: defaultIdeDefaults,
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
    expect(deps.setOpenModalIdeDefaults).toHaveBeenCalledWith(
      defaultIdeDefaults,
    );
  });

  test("uses No IDE defaults when no repo is selected", () => {
    const deps = makeDeps();
    const prepare = createPrepareOpenModal(deps);

    prepare();

    expect(deps.setOpenModalIdeDefaults).toHaveBeenCalledWith(
      defaultIdeDefaults,
    );
  });
});

describe("createHandleOpen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("opens a branch through WorkspaceService, refreshes, and clears pending without registering", async () => {
    const { tuiRuntime, runTuiSilentPromise } = await import(
      "../../src/tui/runtime"
    );

    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const openResult = makeOpenResult();
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(openResult);
    const refreshAll = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      setPendingActions,
      refreshAll,
    });

    createHandleOpen(deps)({
      branch: "feat",
      base: "main",
      pr: "",
      profile: "dev",
      existing: false,
      noIde: true,
      noAttach: true,
    });

    expect(deps.setMode).toHaveBeenCalledWith(Mode.Navigate);
    expect(pendingActions.has(pendingKey("proj", "feat"))).toBe(true);

    await vi.waitFor(() => {
      expect(workspaceOpen).toHaveBeenCalledWith({
        branch: "feat",
        base: "main",
        cwd: "/repo",
        pr: "",
        profile: "dev",
        existing: false,
        ide: false,
        noIde: true,
      });
      expect(tuiRuntime.runPromise).toHaveBeenCalledWith("mock-open-effect");
      expect(refreshAll).toHaveBeenCalled();
    });
    expect(registerProjectMock).not.toHaveBeenCalled();
    expect(runTuiSilentPromise).not.toHaveBeenCalled();
    expect(deps.showActionError).not.toHaveBeenCalled();
    expect(pendingActions.size).toBe(0);
    expect(setPendingActions).toHaveBeenCalledTimes(2);
  });

  test("passes PR opens through WorkspaceService without branch pre-resolution", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(
      makeOpenResult({ branch: "pr-branch", sessionName: "pr-branch" }),
    );

    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      refreshAll: vi.fn().mockResolvedValue(undefined),
    });

    createHandleOpen(deps)({
      branch: "pr-branch",
      pr: "123",
      profile: undefined,
      existing: false,
      noIde: false,
      noAttach: true,
    });

    await vi.waitFor(() => {
      expect(workspaceOpen).toHaveBeenCalledWith({
        branch: undefined,
        base: undefined,
        cwd: "/repo",
        pr: "123",
        profile: undefined,
        existing: false,
        ide: true,
        noIde: false,
      });
      expect(deps.refreshAll).toHaveBeenCalled();
    });
  });

  test("does not register or refresh after fatal WorkspaceService failure and clears pending", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");

    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    (tuiRuntime.runPromise as Mock).mockRejectedValueOnce(
      new Error("open failed"),
    );
    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      setPendingActions,
    });

    createHandleOpen(deps)({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      existing: false,
      noIde: false,
      noAttach: true,
    });

    await vi.waitFor(() => {
      expect(workspaceOpen).toHaveBeenCalledWith({
        branch: "feat",
        base: "",
        cwd: "/repo",
        pr: "",
        profile: "",
        existing: false,
        ide: true,
        noIde: false,
      });
      expect(deps.showActionError).toHaveBeenCalledWith("open failed");
    });
    expect(registerProjectMock).not.toHaveBeenCalled();
    expect(deps.refreshAll).not.toHaveBeenCalled();
    expect(pendingActions.size).toBe(0);
    expect(setPendingActions).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  test("surfaces typed Workspace warnings after a successful open", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(
      makeOpenResult({
        warnings: [
          {
            _tag: "SetupFailed",
            operation: "open",
            name: "bootstrap",
            optional: true,
            error: { code: "optional_setup_failed", message: "missing tool" },
          },
        ],
      }),
    );

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
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(makeOpenResult());

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
    const { tuiRuntime } = await import("../../src/tui/runtime");

    const discoverClient = vi
      .fn<() => Promise<TmuxClientDiscovery>>()
      .mockResolvedValue({
        type: "single",
        client: { tty: "/dev/pts/1", session: "main" },
      });
    const switchSession = vi.fn().mockResolvedValue(true);
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(makeOpenResult());

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
      existing: false,
      noIde: false,
      noAttach: false,
    });

    await vi.waitFor(() => {
      expect(discoverClient).toHaveBeenCalled();
      expect(switchSession).toHaveBeenCalledWith("feat", {
        tty: "/dev/pts/1",
        session: "main",
      });
    });
  });

  test("shows the existing tmux warning when attach was requested but no client is found", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");

    const discoverClient = vi
      .fn<() => Promise<TmuxClientDiscovery>>()
      .mockResolvedValue({ type: "none" });
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(makeOpenResult());

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
    const { tuiRuntime } = await import("../../src/tui/runtime");

    const discoverClient = vi
      .fn<() => Promise<TmuxClientDiscovery>>()
      .mockResolvedValue({ type: "error" });
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(makeOpenResult());

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
    const { tuiRuntime } = await import("../../src/tui/runtime");

    const discoverClient = vi
      .fn<() => Promise<TmuxClientDiscovery>>()
      .mockResolvedValue({ type: "multiple" });
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(makeOpenResult());

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
    const { tuiRuntime } = await import("../../src/tui/runtime");

    const discoverClient = vi.fn();
    const switchSession = vi.fn();
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(makeOpenResult());

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
    const { tuiRuntime } = await import("../../src/tui/runtime");
    const discoverClient = vi.fn();

    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(
      makeOpenResult({
        attempts: {
          ...makeOpenResult().attempts,
          tmux: {
            attempted: true,
            ok: false,
            error: { code: "tmux_failed", message: "no tmux" },
          },
        },
      }),
    );

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
        ideDefaults: defaultIdeDefaults,
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
      Mode.UpModal(
        "/repo/feat",
        pendingKey("proj", "feat"),
        ["dev"],
        defaultIdeDefaults,
      ),
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
        ideDefaults: defaultIdeDefaults,
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
    const upResult = {
      operation: "up" as const,
      worktreePath: "/repo/feat",
      mainRepoPath: "/repo",
      branch: "feat",
      sessionName: "feat",
      projectName: "proj",
      env: {},
      warnings: [],
      attempts: {
        tmux: { attempted: false, reason: "tmux_not_configured" },
        ide: { attempted: false, reason: "ide_not_configured" },
      },
    };
    (tuiRuntime.runPromise as Mock).mockResolvedValue(upResult);

    const returnModeRef = { current: Mode.Navigate };
    const returnIndexRef = { current: 3 };
    const handleStartResult = vi.fn().mockResolvedValue(undefined);
    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const deps = makeDeps({
      mode: Mode.UpModal(
        "/repo/feat",
        "proj/feat",
        ["dev"],
        defaultIdeDefaults,
      ),
      upModalReturnModeRef: returnModeRef,
      upModalReturnSelectedIndexRef: returnIndexRef,
      handleStartResult,
      setPendingActions,
    });
    const handleUp = createHandleUpSubmit(deps);

    handleUp({ profile: "dev", noIde: false, autoSwitch: true });

    expect(deps.clearActionError).toHaveBeenCalled();
    expect(deps.setSelectedIndex).toHaveBeenCalledWith(3);
    expect(deps.setMode).toHaveBeenCalledWith(Mode.Navigate);
    expect(deps.setPendingActions).toHaveBeenCalled();

    // Wait for the async operation
    await vi.waitFor(() => {
      expect(WorkspaceService.use).toHaveBeenCalled();
      expect(workspaceUp).toHaveBeenCalledWith({
        path: "/repo/feat",
        profile: "dev",
        ide: true,
        noIde: false,
      });
      expect(tuiRuntime.runPromise).toHaveBeenCalledWith(
        "mock-workspace-effect",
      );
      expect(handleStartResult).toHaveBeenCalledWith(upResult, true);
    });
    expect(registerProjectMock).not.toHaveBeenCalled();
    expect(pendingActions.size).toBe(0);
    expect(setPendingActions).toHaveBeenCalledTimes(2);
  });

  test("shows error and refreshes on failure", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockRejectedValue(
      new Error("session fail"),
    );

    let pendingActions = new Map<string, unknown>();
    const setPendingActions = vi.fn((update) => {
      pendingActions =
        typeof update === "function" ? update(pendingActions) : update;
      return pendingActions;
    });
    const deps = makeDeps({
      mode: Mode.UpModal("/repo/feat", "proj/feat", [], defaultIdeDefaults),
      upModalReturnModeRef: { current: Mode.Navigate },
      upModalReturnSelectedIndexRef: { current: 0 },
      setPendingActions,
    });
    const handleUp = createHandleUpSubmit(deps);

    handleUp({ profile: undefined, noIde: false, autoSwitch: false });

    await vi.waitFor(() => {
      expect(deps.showActionError).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(deps.refreshAll).toHaveBeenCalled();
    });
    expect(pendingActions.size).toBe(0);
    expect(setPendingActions).toHaveBeenCalledTimes(2);
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
  test("remembers Expanded mode for modal return", () => {
    const expanded = Mode.Expanded("proj/feat");
    const returnModeRef = { current: Mode.Navigate };
    const deps = makeDeps({
      mode: expanded,
      modalReturnModeRef: returnModeRef,
    });

    createPrepareAddProjectModal(deps)();

    expect(returnModeRef.current).toEqual(expanded);
  });

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

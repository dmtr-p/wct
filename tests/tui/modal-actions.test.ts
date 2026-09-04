import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
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
import {
  createLifecycleClaims,
  type LifecycleEntry,
  type LifecyclePhase,
  type LifecycleState,
  lifecycleKey,
  lifecyclePhaseLabel,
} from "../../src/tui/lifecycle";
import { Mode, pendingKey, type TreeItem } from "../../src/tui/types";

// Applies functional updates like React would, so a test can read the phase
// the tree would be rendering at any point in the async flow.
function trackLifecycle() {
  const tracker = {
    state: new Map() as LifecycleState,
    phases: [] as Array<LifecyclePhase | null>,
    setLifecycle: (
      update: LifecycleState | ((prev: LifecycleState) => LifecycleState),
    ) => {
      tracker.state =
        typeof update === "function" ? update(tracker.state) : update;
      tracker.phases.push(tracker.entry()?.phase ?? null);
      return tracker.state;
    },
    entry: (): LifecycleEntry | undefined =>
      tracker.state.get(lifecycleKey("/repo", "feat")),
  };
  return tracker;
}

const workspaceOpen = vi.hoisted(() => vi.fn(() => "mock-open-effect"));
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
    use: vi.fn((f) => f({ open: workspaceOpen })),
  },
}));

vi.mock("../../src/services/project-registration", () => ({
  registerProject: registerProjectMock,
}));

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
      copy: { attempted: false, reason: "not_configured" },
      setup: { attempted: false, reason: "not_configured" },
      tmux: { attempted: true, ok: true, value: { _tag: "Created" } },
    },
    ...overrides,
  };
}

/**
 * The registry snapshot a validation observes when `/repo` really does have a
 * `feat` worktree — i.e. what `refreshAll` resolves after a successful open.
 */
function snapshotWithFeat(): ModalActionDeps["filteredRepos"] {
  return [
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
}

function makeDeps(overrides: Partial<ModalActionDeps> = {}): ModalActionDeps {
  return {
    treeItems: [],
    filteredRepos: [],
    selectedIndex: 0,
    mode: Mode.Navigate,
    openModalRepoProject: "",
    openModalRepoPath: "",
    lifecycle: new Map(),
    lifecycleClaims: createLifecycleClaims(),
    setLifecycle: vi.fn(),
    setMode: vi.fn(),
    setSelectedIndex: vi.fn(),
    markWorkspaceDiscovered: vi.fn(),
    waitForLifecyclePresentationCleanup: vi.fn().mockResolvedValue(undefined),
    setOpenModalBase: vi.fn(),
    setOpenModalProfiles: vi.fn(),
    setOpenModalRepoProject: vi.fn(),
    setOpenModalRepoPath: vi.fn(),
    showActionError: vi.fn(),
    clearActionError: vi.fn(),
    switchSession: vi.fn().mockResolvedValue(true),
    discoverClient: vi.fn().mockResolvedValue({ type: "none" } as const),
    startWorkspace: vi.fn().mockResolvedValue(undefined),
    refreshAll: vi.fn().mockResolvedValue([]),
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

  test("opens a branch through WorkspaceService, refreshes, and leaves the discovered Workspace expanded without registering", async () => {
    const { tuiRuntime, runTuiSilentPromise } = await import(
      "../../src/tui/runtime"
    );

    const openResult = makeOpenResult();
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(openResult);
    const refreshAll = vi.fn().mockResolvedValue(snapshotWithFeat());
    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      refreshAll,
    });

    createHandleOpen(deps)({
      branch: "feat",
      base: "main",
      pr: "",
      profile: "dev",
      existing: false,
      noAttach: true,
    });

    expect(deps.setMode).toHaveBeenCalledWith(Mode.Navigate);

    await vi.waitFor(() => {
      expect(workspaceOpen).toHaveBeenCalledWith({
        branch: "feat",
        base: "main",
        cwd: "/repo",
        pr: "",
        profile: "dev",
        existing: false,
        reporter: expect.any(Object),
      });
      expect(tuiRuntime.runPromise).toHaveBeenCalledWith("mock-open-effect");
      expect(refreshAll).toHaveBeenCalled();
    });
    expect(registerProjectMock).not.toHaveBeenCalled();
    expect(runTuiSilentPromise).not.toHaveBeenCalled();
    expect(deps.showActionError).not.toHaveBeenCalled();
    // A presentation-only override, not the stored preference.
    expect(deps.markWorkspaceDiscovered).toHaveBeenCalledWith(
      lifecycleKey("/repo", "feat"),
    );
  });

  test("passes PR opens through WorkspaceService without branch pre-resolution", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(
      makeOpenResult({ branch: "pr-branch", sessionName: "pr-branch" }),
    );

    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      refreshAll: vi.fn().mockResolvedValue([]),
    });

    createHandleOpen(deps)({
      branch: "pr-branch",
      pr: "123",
      profile: undefined,
      existing: false,
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
        reporter: expect.any(Object),
      });
      expect(deps.refreshAll).toHaveBeenCalled();
    });
  });

  test("validates after a fatal WorkspaceService failure, does not register, and records no discovered Workspace", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    (tuiRuntime.runPromise as Mock).mockRejectedValueOnce(
      new Error("open failed"),
    );
    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
    });

    createHandleOpen(deps)({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      existing: false,
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
        reporter: expect.any(Object),
      });
      expect(deps.showActionError).toHaveBeenCalledWith("open failed");
    });
    expect(registerProjectMock).not.toHaveBeenCalled();
    expect(deps.refreshAll).toHaveBeenCalled();
    expect(deps.markWorkspaceDiscovered).not.toHaveBeenCalled();
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
      refreshAll: vi.fn().mockResolvedValue([]),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      existing: false,
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
      refreshAll: vi.fn().mockResolvedValue([]),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      existing: false,
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
      refreshAll: vi.fn().mockResolvedValue([]),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      existing: false,
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
      refreshAll: vi.fn().mockResolvedValue([]),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      existing: false,
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
      refreshAll: vi.fn().mockResolvedValue([]),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      existing: false,
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
      refreshAll: vi.fn().mockResolvedValue([]),
    });
    const handleOpen = createHandleOpen(deps);

    handleOpen({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      existing: false,
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
      refreshAll: vi.fn().mockResolvedValue([]),
    });

    createHandleOpen(deps)({
      branch: "feat",
      base: undefined,
      pr: undefined,
      profile: undefined,
      existing: false,
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
      Mode.UpModal({
        worktreePath: "/repo/feat",
        worktreeKey: pendingKey("proj", "feat"),
        repoPath: "/repo",
        branch: "feat",
        project: "proj",
        profileNames: ["dev"],
      }),
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

  test("refuses to open the option sheet for a Workspace under an active lifecycle", () => {
    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const deps = makeDeps({
      treeItems: items,
      filteredRepos: snapshotWithFeat(),
      selectedIndex: 0,
      lifecycle: new Map([
        [
          lifecycleKey("/repo", "feat"),
          {
            operation: "up" as const,
            repoPath: "/repo",
            project: "proj",
            branch: "feat",
            phase: { _tag: "RunningSetup" as const, name: "install" },
          },
        ],
      ]),
    });

    createPrepareUpModal(deps)();

    expect(deps.setMode).not.toHaveBeenCalled();
    const message = vi.mocked(deps.showActionError).mock.calls[0]?.[0];
    expect(message).toContain("feat");
    expect(message).toContain(
      lifecyclePhaseLabel({ _tag: "RunningSetup", name: "install" }),
    );
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

  test("restores return mode and index, then delegates to the shared up lifecycle", async () => {
    const returnModeRef = { current: Mode.Navigate };
    const returnIndexRef = { current: 3 };
    const startWorkspace = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      mode: Mode.UpModal({
        worktreePath: "/repo/feat",
        worktreeKey: "proj/feat",
        repoPath: "/repo",
        branch: "feat",
        project: "proj",
        profileNames: ["dev"],
      }),
      upModalReturnModeRef: returnModeRef,
      upModalReturnSelectedIndexRef: returnIndexRef,
      startWorkspace,
    });
    const handleUp = createHandleUpSubmit(deps);

    handleUp({ profile: "dev", autoSwitch: true });

    expect(deps.clearActionError).toHaveBeenCalled();
    expect(deps.setSelectedIndex).toHaveBeenCalledWith(3);
    expect(deps.setMode).toHaveBeenCalledWith(Mode.Navigate);
    expect(startWorkspace).toHaveBeenCalledWith({
      worktreePath: "/repo/feat",
      repoPath: "/repo",
      project: "proj",
      branch: "feat",
      profile: "dev",
      autoSwitch: true,
    });
    expect(registerProjectMock).not.toHaveBeenCalled();
  });

  test("keeps identity intact when the project name contains a slash", () => {
    const startWorkspace = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      mode: Mode.UpModal({
        worktreePath: "/repo/my-feature",
        worktreeKey: pendingKey("myorg/webapp", "my-feature"),
        repoPath: "/repo",
        branch: "my-feature",
        project: "myorg/webapp",
        profileNames: ["dev"],
      }),
      upModalReturnModeRef: { current: Mode.Navigate },
      upModalReturnSelectedIndexRef: { current: 0 },
      startWorkspace,
    });

    createHandleUpSubmit(deps)({ profile: undefined, autoSwitch: false });

    expect(startWorkspace).toHaveBeenCalledWith({
      worktreePath: "/repo/my-feature",
      repoPath: "/repo",
      project: "myorg/webapp",
      branch: "my-feature",
      autoSwitch: false,
    });
  });

  test("no-op when mode is not UpModal", () => {
    const deps = makeDeps({ mode: Mode.Navigate });
    const handleUp = createHandleUpSubmit(deps);

    handleUp({ profile: undefined, autoSwitch: false });

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
      refreshAll: vi.fn().mockResolvedValue([]),
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

describe("open lifecycle reconciliation", () => {
  test("validates and refreshes before the lifecycle presentation is removed", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(
      makeOpenResult({ attempts: { ...makeOpenResult().attempts } }),
    );
    const tracker = trackLifecycle();
    const phaseAtRefresh: Array<LifecyclePhase | undefined> = [];
    const entryAtRefresh: Array<boolean> = [];
    const refreshAll = vi.fn().mockImplementation(async () => {
      phaseAtRefresh.push(tracker.entry()?.phase);
      entryAtRefresh.push(tracker.state.size > 0);
      return snapshotWithFeat();
    });
    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      setLifecycle: tracker.setLifecycle,
      refreshAll,
      // Keep the tmux switch out of this test's way.
      discoverClient: vi.fn().mockResolvedValue({ type: "none" } as const),
    });

    createHandleOpen(deps)({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      existing: false,
      noAttach: true,
    });

    expect(tracker.entry()?.phase).toEqual({ _tag: "Preparing" });

    await vi.waitFor(() => {
      expect(refreshAll).toHaveBeenCalled();
      expect(tracker.state.size).toBe(0);
    });

    expect(phaseAtRefresh).toEqual([{ _tag: "Validating" }]);
    expect(entryAtRefresh).toEqual([true]);
    expect(tracker.phases).toContainEqual({ _tag: "Validating" });
    expect(tracker.phases[tracker.phases.length - 1]).toBeNull();
    // A presentation-only override; setExpandedWorktreeKeys is out of reach here.
    expect(deps.markWorkspaceDiscovered).toHaveBeenCalledWith(
      lifecycleKey("/repo", "feat"),
    );
    expect(deps).not.toHaveProperty("setExpandedWorktreeKeys");
  });

  test("records the expansion override only for an identity validation found on disk", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");

    // Worktree created, a later phase then failed fatally.
    (tuiRuntime.runPromise as Mock).mockRejectedValueOnce(
      new Error("setup command failed"),
    );
    const partial = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      refreshAll: vi.fn().mockResolvedValue(snapshotWithFeat()),
    });
    createHandleOpen(partial)({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      existing: false,
      noAttach: true,
    });
    await vi.waitFor(() => {
      expect(partial.showActionError).toHaveBeenCalledWith(
        "setup command failed",
      );
    });
    expect(partial.markWorkspaceDiscovered).toHaveBeenCalledWith(
      lifecycleKey("/repo", "feat"),
    );

    // A same-named worktree in another repository: identity matches on repo path.
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(makeOpenResult());
    const otherRepo = snapshotWithFeat().map((repo) => ({
      ...repo,
      repoPath: "/other-repo",
    }));
    const elsewhere = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      refreshAll: vi.fn().mockResolvedValue(otherRepo),
    });
    createHandleOpen(elsewhere)({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      existing: false,
      noAttach: true,
    });
    await vi.waitFor(() => {
      expect(elsewhere.refreshAll).toHaveBeenCalled();
    });
    expect(elsewhere.markWorkspaceDiscovered).not.toHaveBeenCalled();

    // A matching display name is never a substitute for main-repository path.
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(makeOpenResult());
    const unidentified = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "",
      refreshAll: vi.fn().mockResolvedValue(snapshotWithFeat()),
    });
    createHandleOpen(unidentified)({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      existing: false,
      noAttach: true,
    });
    await vi.waitFor(() => {
      expect(unidentified.refreshAll).toHaveBeenCalled();
    });
    expect(unidentified.markWorkspaceDiscovered).not.toHaveBeenCalled();

    // A validation that observed nothing at all.
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(makeOpenResult());
    const blind = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      refreshAll: vi.fn().mockResolvedValue(null),
    });
    createHandleOpen(blind)({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      existing: false,
      noAttach: true,
    });
    await vi.waitFor(() => {
      expect(blind.showActionError).toHaveBeenCalled();
    });
    expect(blind.markWorkspaceDiscovered).not.toHaveBeenCalled();
  });

  test("validates and refreshes after a FAILED open before any lifecycle UI is removed", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockRejectedValueOnce(
      new Error("worktree add failed"),
    );
    const tracker = trackLifecycle();
    const atRefresh: Array<{
      phase: LifecyclePhase | undefined;
      entries: number;
    }> = [];
    const refreshAll = vi.fn().mockImplementation(async () => {
      atRefresh.push({
        phase: tracker.entry()?.phase,
        entries: tracker.state.size,
      });
      return [];
    });
    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      setLifecycle: tracker.setLifecycle,
      refreshAll,
    });

    createHandleOpen(deps)({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      existing: false,
      noAttach: true,
    });

    await vi.waitFor(() => {
      expect(deps.showActionError).toHaveBeenCalledWith("worktree add failed");
    });

    expect(atRefresh).toEqual([{ phase: { _tag: "Validating" }, entries: 1 }]);
    expect(tracker.state.size).toBe(0);
    expect(tracker.phases[tracker.phases.length - 1]).toBeNull();
  });

  test("defers warnings until validation has completed and progress is gone", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(
      makeOpenResult({
        warnings: [
          {
            _tag: "SetupFailed",
            operation: "open",
            name: "bootstrap",
            optional: false,
            error: { code: "setup_failed", message: "exit 1" },
          },
          {
            _tag: "TmuxStartFailed",
            operation: "open",
            error: { code: "tmux_failed", message: "no server" },
          },
        ],
      }),
    );
    const tracker = trackLifecycle();
    const order: string[] = [];
    const showActionError = vi.fn((message: string) => {
      order.push(`error(lifecycle=${tracker.state.size}):${message}`);
    });
    const refreshAll = vi.fn().mockImplementation(async () => {
      order.push(`refresh(errors=${showActionError.mock.calls.length})`);
      return [];
    });
    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      setLifecycle: tracker.setLifecycle,
      showActionError,
      refreshAll,
    });

    createHandleOpen(deps)({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      existing: false,
      noAttach: true,
    });

    await vi.waitFor(() => {
      expect(showActionError).toHaveBeenCalled();
    });

    expect(order).toEqual([
      "refresh(errors=0)",
      "error(lifecycle=0):Setup failed: bootstrap: exit 1\nFailed to create tmux session: no server",
    ]);
  });

  test("each concurrent open consumes its OWN validation snapshot and clears only its own identity", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    // Shared state, as React's single `setLifecycle` would be shared by two in-flight handlers.
    let shared: LifecycleState = new Map();
    const setLifecycle = (
      update: LifecycleState | ((prev: LifecycleState) => LifecycleState),
    ) => {
      shared = typeof update === "function" ? update(shared) : update;
    };
    const defer = () => {
      let resolve: (value: unknown[] | null) => void = () => undefined;
      const promise = new Promise<unknown[] | null>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };
    const validationA = defer();
    const validationB = defer();
    (tuiRuntime.runPromise as Mock)
      .mockResolvedValueOnce(makeOpenResult({ mainRepoPath: "/repo-a" }))
      .mockResolvedValueOnce(makeOpenResult({ mainRepoPath: "/repo-b" }));

    const errorsA: string[] = [];
    const errorsB: string[] = [];
    const depsA = makeDeps({
      openModalRepoProject: "a",
      openModalRepoPath: "/repo-a",
      setLifecycle,
      showActionError: (message: string) => errorsA.push(message),
      refreshAll: vi.fn(
        () => validationA.promise,
      ) as unknown as ModalActionDeps["refreshAll"],
    });
    const depsB = makeDeps({
      openModalRepoProject: "b",
      openModalRepoPath: "/repo-b",
      setLifecycle,
      showActionError: (message: string) => errorsB.push(message),
      refreshAll: vi.fn(
        () => validationB.promise,
      ) as unknown as ModalActionDeps["refreshAll"],
    });

    const submit = {
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      existing: false,
      noAttach: true,
    };
    createHandleOpen(depsA)(submit);
    createHandleOpen(depsB)(submit);

    await vi.waitFor(() => {
      expect(shared.get(lifecycleKey("/repo-a", "feat"))?.phase).toEqual({
        _tag: "Validating",
      });
      expect(shared.get(lifecycleKey("/repo-b", "feat"))?.phase).toEqual({
        _tag: "Validating",
      });
    });

    validationA.resolve(null);
    await vi.waitFor(() => {
      expect(errorsA).toEqual([
        "Validation after open failed — showing the last known Workspace state",
      ]);
    });
    expect(shared.has(lifecycleKey("/repo-a", "feat"))).toBe(false);
    expect(shared.get(lifecycleKey("/repo-b", "feat"))?.phase).toEqual({
      _tag: "Validating",
    });

    validationB.resolve([]);
    await vi.waitFor(() => {
      expect(shared.size).toBe(0);
    });
    expect(errorsB).toEqual([]);
  });

  test("switches the tmux client only after validation and lifecycle removal", async () => {
    const { tuiRuntime } = await import("../../src/tui/runtime");
    (tuiRuntime.runPromise as Mock).mockResolvedValueOnce(makeOpenResult());
    const tracker = trackLifecycle();
    const order: string[] = [];
    const refreshAll = vi.fn().mockImplementation(async () => {
      order.push("refresh");
      return [];
    });
    const discoverClient = vi.fn().mockImplementation(async () => {
      order.push(`discover(lifecycle=${tracker.state.size})`);
      return { type: "single", client: null } as unknown as TmuxClientDiscovery;
    });
    const switchSession = vi.fn().mockImplementation(async () => {
      order.push(`switch(lifecycle=${tracker.state.size})`);
      return false;
    });
    const deps = makeDeps({
      openModalRepoProject: "proj",
      openModalRepoPath: "/repo",
      setLifecycle: tracker.setLifecycle,
      refreshAll,
      discoverClient,
      switchSession,
    });

    createHandleOpen(deps)({
      branch: "feat",
      base: "",
      pr: "",
      profile: "",
      existing: false,
      noAttach: false,
    });

    await vi.waitFor(() => {
      expect(switchSession).toHaveBeenCalled();
      expect(deps.showActionError).toHaveBeenCalled();
    });

    expect(order).toEqual([
      "refresh",
      "discover(lifecycle=0)",
      "switch(lifecycle=0)",
    ]);
    expect(deps.showActionError).toHaveBeenCalledWith(
      "Started session 'feat', but failed to switch client",
    );
    expect(tracker.state.size).toBe(0);
    expect(tracker.phases[tracker.phases.length - 1]).toBeNull();
  });
});

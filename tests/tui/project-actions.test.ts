import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ProjectActionDeps } from "../../src/tui/hooks/useProjectActions";
import {
  createExecuteDeleteProject,
  createPrepareDeleteProject,
} from "../../src/tui/hooks/useProjectActions";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { lifecycleKey } from "../../src/tui/lifecycle";
import { tuiRuntime } from "../../src/tui/runtime";
import { Mode } from "../../src/tui/types";

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: { runPromise: vi.fn() },
}));

const { down, unregister, invalidate } = vi.hoisted(() => ({
  down: vi.fn((options: { path: string }) => ({
    operation: "down",
    path: options.path,
  })),
  unregister: vi.fn((repoPath: string) => ({
    operation: "unregister",
    repoPath,
  })),
  invalidate: vi.fn((project: string) => ({
    operation: "invalidate",
    project,
  })),
}));

vi.mock("../../src/services/workspace-service", () => ({
  WorkspaceService: { use: vi.fn((f) => f({ down })) },
}));
vi.mock("../../src/services/registry-service", () => ({
  RegistryService: { use: vi.fn((f) => f({ unregister })) },
}));
vi.mock("../../src/services/pr-cache-service", () => ({
  PrCacheService: { use: vi.fn((f) => f({ invalidate })) },
}));

const repo: RepoInfo = {
  id: "repo-id",
  repoPath: "/repos/project",
  project: "project",
  worktrees: [
    {
      branch: "main",
      path: "/repos/project",
      isMainWorktree: true,
      changedFiles: 0,
      sync: null,
    },
    {
      branch: "feature",
      path: "/worktrees/project-feature",
      isMainWorktree: false,
      changedFiles: 0,
      sync: null,
    },
  ],
  profileNames: [],
};

function makeDeps(
  overrides: Partial<ProjectActionDeps> = {},
): ProjectActionDeps {
  return {
    treeItems: [{ type: "repo", repoIndex: 0 }],
    filteredRepos: [repo],
    repos: [repo],
    selectedIndex: 0,
    mode: Mode.Navigate,
    lifecycle: new Map(),
    setSelectedIndex: vi.fn(),
    setMode: vi.fn(),
    showActionError: vi.fn(),
    clearActionError: vi.fn(),
    refreshAll: vi.fn().mockResolvedValue([]),
    restoreConfirmationViewport: vi.fn(),
    switchClientAwayFromSessions: vi.fn().mockResolvedValue(true),
    confirmDeleteProjectReturnModeRef: { current: Mode.Navigate },
    confirmDeleteProjectReturnSelectedIndexRef: { current: 0 },
    ...overrides,
  };
}

describe("createPrepareDeleteProject", () => {
  test("opens confirmation for a selected project row", () => {
    const deps = makeDeps();

    createPrepareDeleteProject(deps)();

    expect(deps.setMode).toHaveBeenCalledWith(
      Mode.ConfirmDeleteProject(repo.repoPath, repo.project),
    );
  });

  test("uses the unfiltered project to guard every workspace lifecycle", () => {
    const deps = makeDeps({
      filteredRepos: [{ ...repo, worktrees: [repo.worktrees[0]!] }],
      lifecycle: new Map([
        [
          lifecycleKey(repo.repoPath, "feature"),
          {
            operation: "up",
            repoPath: repo.repoPath,
            project: repo.project,
            branch: "feature",
            phase: { _tag: "CreatingTmuxSession" },
          },
        ],
      ]),
    });

    createPrepareDeleteProject(deps)();

    expect(deps.setMode).not.toHaveBeenCalled();
    expect(deps.showActionError).toHaveBeenCalledWith(
      "'feature' is busy (Creating tmux session…)",
    );
  });
});

describe("createExecuteDeleteProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tuiRuntime.runPromise).mockImplementation(
      (effect) => Promise.resolve(effect) as never,
    );
  });

  test("downs every worktree before unregistering and keeps worktrees intact", async () => {
    const deps = makeDeps();

    await createExecuteDeleteProject(deps)(repo.repoPath, repo.project);

    expect(deps.switchClientAwayFromSessions).toHaveBeenCalledWith([
      "project",
      "project-feature",
    ]);
    expect(down).toHaveBeenCalledTimes(2);
    expect(down).toHaveBeenCalledWith({ path: "/repos/project" });
    expect(down).toHaveBeenCalledWith({ path: "/worktrees/project-feature" });
    expect(unregister).toHaveBeenCalledWith(repo.repoPath);
    expect(invalidate).toHaveBeenCalledWith(repo.project);
    expect(deps.refreshAll).toHaveBeenCalled();
  });

  test("keeps the project registered when any down fails", async () => {
    vi.mocked(tuiRuntime.runPromise).mockImplementation((effect) => {
      if (
        typeof effect === "object" &&
        effect !== null &&
        "path" in effect &&
        effect.path === "/worktrees/project-feature"
      ) {
        return Promise.reject(new Error("tmux failed")) as never;
      }
      return Promise.resolve(effect) as never;
    });
    const deps = makeDeps();

    await createExecuteDeleteProject(deps)(repo.repoPath, repo.project);

    expect(down).toHaveBeenCalledTimes(2);
    expect(unregister).not.toHaveBeenCalled();
    expect(deps.showActionError).toHaveBeenCalledWith(
      "Failed to stop all sessions for 'project': feature: tmux failed",
    );
  });

  test("keeps the project registered when client handoff is unsafe", async () => {
    const deps = makeDeps({
      switchClientAwayFromSessions: vi.fn().mockResolvedValue(false),
    });

    await createExecuteDeleteProject(deps)(repo.repoPath, repo.project);

    expect(down).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect(deps.showActionError).toHaveBeenCalledWith(
      "Cannot safely delete the project because the active tmux client could not be moved away",
    );
  });
});

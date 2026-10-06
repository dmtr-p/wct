import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { commandError } from "../../src/errors";
import type { ProjectActionDeps } from "../../src/tui/hooks/useProjectActions";
import {
  createExecuteRemoveProject,
  createPrepareRemoveProject,
} from "../../src/tui/hooks/useProjectActions";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { workspaceIdentityKey } from "../../src/tui/lifecycle";
import { Mode } from "../../src/tui/types";

vi.mock("../../src/tui/runtime", async () => {
  const { Effect } = await vi.importActual<typeof import("effect")>("effect");
  return {
    tuiRuntime: {
      runPromise: vi.fn((effect: unknown) =>
        Effect.runPromise(
          effect as import("effect").Effect.Effect<unknown, unknown>,
        ),
      ),
    },
  };
});

const { down, unregister, invalidate } = vi.hoisted(() => ({
  down: vi.fn(),
  unregister: vi.fn(),
  invalidate: vi.fn(),
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
    captureTreeReturnPosition: vi.fn(),
    restoreTreeReturnPosition: vi.fn(),
    setMode: vi.fn(),
    showActionError: vi.fn(),
    clearActionError: vi.fn(),
    refreshAll: vi.fn().mockResolvedValue([]),
    switchClientAwayFromSessions: vi.fn().mockResolvedValue(true),
    confirmRemoveProjectReturnModeRef: { current: Mode.Navigate },
    ...overrides,
  };
}

describe("createPrepareRemoveProject", () => {
  test("opens confirmation for a selected project row", () => {
    const deps = makeDeps();

    createPrepareRemoveProject(deps)();

    expect(deps.setMode).toHaveBeenCalledWith(
      Mode.ConfirmRemoveProject(repo.repoPath, repo.project),
    );
  });

  test("uses the unfiltered project to guard every workspace lifecycle", () => {
    const mainWorktree = repo.worktrees[0];
    if (!mainWorktree) throw new Error("missing main worktree fixture");
    const deps = makeDeps({
      filteredRepos: [{ ...repo, worktrees: [mainWorktree] }],
      lifecycle: new Map([
        [
          workspaceIdentityKey(repo.repoPath, "feature"),
          {
            operation: "up",
            repoPath: repo.repoPath,
            project: repo.project,
            branch: "feature",
            phase: { _tag: "StartingTmuxSession" },
          },
        ],
      ]),
    });

    createPrepareRemoveProject(deps)();

    expect(deps.setMode).not.toHaveBeenCalled();
    expect(deps.showActionError).toHaveBeenCalledWith(
      "'feature' is busy (Starting tmux session…)",
    );
  });
});

describe("createExecuteRemoveProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    down.mockImplementation((options: { path: string }) =>
      Effect.succeed({ operation: "down", path: options.path }),
    );
    unregister.mockImplementation((repoPath: string) =>
      Effect.succeed({ operation: "unregister", repoPath }),
    );
    invalidate.mockImplementation((repoPath: string) =>
      Effect.succeed({ operation: "invalidate", repoPath }),
    );
  });

  test("removal stops and invalidates only the selected same-named repository", async () => {
    const mainWorktree = repo.worktrees[0];
    if (!mainWorktree) throw new Error("missing main worktree fixture");
    const sibling = {
      ...repo,
      id: "sibling-id",
      repoPath: "/repos/sibling",
      worktrees: [{ ...mainWorktree, path: "/repos/sibling" }],
    };
    const deps = makeDeps({ repos: [repo, sibling] });

    await createExecuteRemoveProject(deps)(repo.repoPath, repo.project);

    expect(deps.switchClientAwayFromSessions).toHaveBeenCalledWith([
      "project",
      "project-feature",
    ]);
    expect(down).toHaveBeenCalledTimes(2);
    expect(down).toHaveBeenCalledWith({ path: "/repos/project" });
    expect(down).toHaveBeenCalledWith({ path: "/worktrees/project-feature" });
    expect(unregister).toHaveBeenCalledWith(repo.repoPath);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(repo.repoPath);
    expect(deps.refreshAll).toHaveBeenCalled();
  });

  test("keeps the project registered when any down fails", async () => {
    down.mockImplementation((options: { path: string }) =>
      options.path === "/worktrees/project-feature"
        ? Effect.fail(commandError("tmux_error", "tmux failed"))
        : Effect.succeed({ operation: "down", path: options.path }),
    );
    const deps = makeDeps();

    await createExecuteRemoveProject(deps)(repo.repoPath, repo.project);

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

    await createExecuteRemoveProject(deps)(repo.repoPath, repo.project);

    expect(down).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect(deps.showActionError).toHaveBeenCalledWith(
      "Cannot safely remove the project because the active tmux client could not be moved away",
    );
  });

  test("reports a failed validation refresh after unregistering", async () => {
    const deps = makeDeps({
      refreshAll: vi.fn().mockResolvedValue(null),
    });

    await createExecuteRemoveProject(deps)(repo.repoPath, repo.project);

    expect(unregister).toHaveBeenCalledWith(repo.repoPath);
    expect(deps.showActionError).toHaveBeenCalledWith(
      "Project was removed from the registry, but validation refresh failed — showing the last known project state",
    );
  });
});

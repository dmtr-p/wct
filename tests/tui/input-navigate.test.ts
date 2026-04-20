import type { Key } from "ink";
import { describe, expect, test, vi } from "vitest";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import {
  handleNavigateInput,
  type NavigateContext,
} from "../../src/tui/input/navigate";
import { Mode, type TreeItem } from "../../src/tui/types";

const noKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

function makeCtx(overrides?: Partial<NavigateContext>): NavigateContext {
  return {
    treeItems: [],
    filteredRepos: [],
    selectedIndex: 0,
    expandedRepos: new Set<string>(),
    tmuxClient: { tty: "/dev/pts/1", session: "test" },
    setMode: vi.fn(),
    setSearchQuery: vi.fn(),
    navigateTree: vi.fn(),
    toggleExpanded: vi.fn(),
    prepareOpenModal: vi.fn(),
    prepareUpModal: vi.fn(),
    handleSpaceSwitch: vi.fn(),
    handleDownSelectedWorktree: vi.fn(),
    handleCloseSelectedWorktree: vi.fn(),
    ...overrides,
  };
}

describe("handleNavigateInput", () => {
  test("/ sets mode to Search and clears search query", () => {
    const ctx = makeCtx();
    handleNavigateInput(ctx, "/", noKey);
    expect(ctx.setMode).toHaveBeenCalledWith(Mode.Search);
    expect(ctx.setSearchQuery).toHaveBeenCalledWith("");
  });

  test("o calls prepareOpenModal", () => {
    const ctx = makeCtx();
    handleNavigateInput(ctx, "o", noKey);
    expect(ctx.prepareOpenModal).toHaveBeenCalled();
  });

  test("space calls handleSpaceSwitch when tmuxClient is set", () => {
    const ctx = makeCtx();
    handleNavigateInput(ctx, " ", noKey);
    expect(ctx.handleSpaceSwitch).toHaveBeenCalled();
  });

  test("space does NOT call handleSpaceSwitch when tmuxClient is null", () => {
    const ctx = makeCtx({ tmuxClient: null });
    handleNavigateInput(ctx, " ", noKey);
    expect(ctx.handleSpaceSwitch).not.toHaveBeenCalled();
  });

  test("d calls handleDownSelectedWorktree when tmuxClient is set", () => {
    const ctx = makeCtx();
    handleNavigateInput(ctx, "d", noKey);
    expect(ctx.handleDownSelectedWorktree).toHaveBeenCalled();
  });

  test("d does NOT call handleDownSelectedWorktree when tmuxClient is null", () => {
    const ctx = makeCtx({ tmuxClient: null });
    handleNavigateInput(ctx, "d", noKey);
    expect(ctx.handleDownSelectedWorktree).not.toHaveBeenCalled();
  });

  test("u calls prepareUpModal", () => {
    const ctx = makeCtx();
    handleNavigateInput(ctx, "u", noKey);
    expect(ctx.prepareUpModal).toHaveBeenCalled();
  });

  test("up arrow calls navigateTree(-1)", () => {
    const ctx = makeCtx();
    handleNavigateInput(ctx, "", { ...noKey, upArrow: true });
    expect(ctx.navigateTree).toHaveBeenCalledWith(-1);
  });

  test("down arrow calls navigateTree(1)", () => {
    const ctx = makeCtx();
    handleNavigateInput(ctx, "", { ...noKey, downArrow: true });
    expect(ctx.navigateTree).toHaveBeenCalledWith(1);
  });

  test("left arrow on repo row calls toggleExpanded when repo is expanded", () => {
    const repos = [
      { id: "repo1", project: "myproj", worktrees: [] },
    ] as unknown as RepoInfo[];
    const items: TreeItem[] = [{ type: "repo", repoIndex: 0 }];
    const ctx = makeCtx({
      treeItems: items,
      filteredRepos: repos,
      expandedRepos: new Set(["repo1"]),
      selectedIndex: 0,
    });
    handleNavigateInput(ctx, "", { ...noKey, leftArrow: true });
    expect(ctx.toggleExpanded).toHaveBeenCalledWith("repo1");
  });

  test("left arrow on repo row does nothing when repo is NOT expanded", () => {
    const repos = [
      { id: "repo1", project: "myproj", worktrees: [] },
    ] as unknown as RepoInfo[];
    const items: TreeItem[] = [{ type: "repo", repoIndex: 0 }];
    const ctx = makeCtx({
      treeItems: items,
      filteredRepos: repos,
      expandedRepos: new Set(),
      selectedIndex: 0,
    });
    handleNavigateInput(ctx, "", { ...noKey, leftArrow: true });
    expect(ctx.toggleExpanded).not.toHaveBeenCalled();
  });

  test("right arrow on repo row calls toggleExpanded when not expanded", () => {
    const repos = [
      { id: "repo1", project: "myproj", worktrees: [] },
    ] as unknown as RepoInfo[];
    const items: TreeItem[] = [{ type: "repo", repoIndex: 0 }];
    const ctx = makeCtx({
      treeItems: items,
      filteredRepos: repos,
      expandedRepos: new Set(),
      selectedIndex: 0,
    });
    handleNavigateInput(ctx, "", { ...noKey, rightArrow: true });
    expect(ctx.toggleExpanded).toHaveBeenCalledWith("repo1");
  });

  test("right arrow on worktree row sets mode to Expanded with correct worktreeKey", () => {
    const repos = [
      {
        id: "repo1",
        project: "myproj",
        worktrees: [{ branch: "feat", path: "/tmp/feat" }],
      },
    ] as unknown as RepoInfo[];
    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const ctx = makeCtx({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
    });
    handleNavigateInput(ctx, "", { ...noKey, rightArrow: true });
    expect(ctx.setMode).toHaveBeenCalledWith(Mode.Expanded("myproj/feat"));
  });

  test("c fires handleCloseSelectedWorktree when selected item is worktree type", () => {
    const repos = [
      {
        id: "repo1",
        project: "myproj",
        worktrees: [{ branch: "feat", path: "/tmp/feat" }],
      },
    ] as unknown as RepoInfo[];
    const items: TreeItem[] = [
      { type: "worktree", repoIndex: 0, worktreeIndex: 0 },
    ];
    const ctx = makeCtx({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
    });
    handleNavigateInput(ctx, "c", noKey);
    expect(ctx.handleCloseSelectedWorktree).toHaveBeenCalled();
  });

  test("c does NOT fire handleCloseSelectedWorktree when selected item is repo type", () => {
    const repos = [
      { id: "repo1", project: "myproj", worktrees: [] },
    ] as unknown as RepoInfo[];
    const items: TreeItem[] = [{ type: "repo", repoIndex: 0 }];
    const ctx = makeCtx({
      treeItems: items,
      filteredRepos: repos,
      selectedIndex: 0,
    });
    handleNavigateInput(ctx, "c", noKey);
    expect(ctx.handleCloseSelectedWorktree).not.toHaveBeenCalled();
  });
});

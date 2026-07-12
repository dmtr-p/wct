import type { Key } from "ink";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type ExpandedContext,
  handleExpandedInput,
} from "../../src/tui/input/expanded";
import type { NavigateContext } from "../../src/tui/input/navigate";
import {
  findOwningWorktreeIndex,
  resolveExpandedRightArrowAction,
  resolveSelectedPane,
} from "../../src/tui/tree-helpers";
import { Mode } from "../../src/tui/types";

vi.mock("../../src/tui/tree-helpers", () => ({
  findOwningWorktreeIndex: vi.fn(() => null),
  resolveExpandedRightArrowAction: vi.fn(() => ({ type: "noop" })),
  resolveSelectedPane: vi.fn(() => null),
}));

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

function makeNavCtx(overrides?: Partial<NavigateContext>): NavigateContext {
  return {
    treeItems: [],
    filteredRepos: [],
    selectedIndex: 0,
    tmuxClient: { tty: "/dev/pts/1", session: "test" },
    setMode: vi.fn(),
    setSearchQuery: vi.fn(),
    expandWorktree: vi.fn(),
    navigateTree: vi.fn(),
    prepareOpenModal: vi.fn(),
    prepareUpModal: vi.fn(),
    handleSpaceSwitch: vi.fn(),
    handleDownSelectedWorktree: vi.fn(),
    handleCloseSelectedWorktree: vi.fn(),
    prepareAddProjectModal: vi.fn(),
    refreshRepo: vi.fn(),
    ...overrides,
  };
}

function makeExpCtx(overrides?: Partial<ExpandedContext>): ExpandedContext {
  return {
    ...makeNavCtx(),
    panes: new Map(),
    setSelectedIndex: vi.fn(),
    zoomPane: vi.fn(() => Promise.resolve(true)),
    killPane: vi.fn(() => Promise.resolve(true)),
    refreshSessions: vi.fn(() => Promise.resolve([])),
    collapseWorktree: vi.fn(),
    ...overrides,
  };
}

describe("handleExpandedInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findOwningWorktreeIndex).mockImplementation(() => null);
    vi.mocked(resolveExpandedRightArrowAction).mockImplementation(() => ({
      type: "noop",
    }));
    vi.mocked(resolveSelectedPane).mockImplementation(() => null);
  });

  test("left arrow collapses only the owning worktree", () => {
    vi.mocked(findOwningWorktreeIndex).mockReturnValue(0);
    const ctx = makeExpCtx({
      treeItems: [{ type: "worktree", repoIndex: 0, worktreeIndex: 0 }],
      filteredRepos: [
        {
          id: "repo",
          project: "proj",
          repoPath: "/tmp/repo",
          worktrees: [
            {
              branch: "feat",
              path: "/tmp/repo/feat",
              isMainWorktree: false,
              changedFiles: 0,
              sync: null,
            },
          ],
          profileNames: [],
        },
      ],
    });
    handleExpandedInput(ctx, "", { ...noKey, leftArrow: true });
    expect(findOwningWorktreeIndex).toHaveBeenCalledWith(
      ctx.treeItems,
      ctx.selectedIndex,
    );
    expect(ctx.setSelectedIndex).toHaveBeenCalledWith(0);
    expect(ctx.collapseWorktree).toHaveBeenCalledWith("proj/feat");
  });

  test("escape does not collapse worktrees", () => {
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "", { ...noKey, escape: true });
    expect(ctx.setSelectedIndex).not.toHaveBeenCalled();
    expect(ctx.collapseWorktree).not.toHaveBeenCalled();
  });

  test("up arrow calls navigateTree(-1)", () => {
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "", { ...noKey, upArrow: true });
    expect(ctx.navigateTree).toHaveBeenCalledWith(-1);
  });

  test("down arrow calls navigateTree(1)", () => {
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "", { ...noKey, downArrow: true });
    expect(ctx.navigateTree).toHaveBeenCalledWith(1);
  });

  test("right arrow handles expand-worktree action", () => {
    vi.mocked(resolveExpandedRightArrowAction).mockReturnValue({
      type: "expand-worktree",
      worktreeKey: "proj/feat",
      nextSelectedIndex: 3,
    });
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "", { ...noKey, rightArrow: true });
    expect(ctx.setSelectedIndex).toHaveBeenCalledWith(3);
    expect(ctx.expandWorktree).toHaveBeenCalledWith("proj/feat");
  });

  test("space with tmuxClient calls handleSpaceSwitch", () => {
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, " ", noKey);
    expect(ctx.handleSpaceSwitch).toHaveBeenCalled();
  });

  test("o calls prepareOpenModal", () => {
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "o", noKey);
    expect(ctx.prepareOpenModal).toHaveBeenCalled();
  });

  test("d with tmuxClient calls handleDownSelectedWorktree", () => {
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "d", noKey);
    expect(ctx.handleDownSelectedWorktree).toHaveBeenCalled();
  });

  test("u calls prepareUpModal", () => {
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "u", noKey);
    expect(ctx.prepareUpModal).toHaveBeenCalled();
  });

  test("c calls handleCloseSelectedWorktree without type guard", () => {
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "c", noKey);
    expect(ctx.handleCloseSelectedWorktree).toHaveBeenCalled();
  });

  test("/ sets mode to Search and clears search query", () => {
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "/", noKey);
    expect(ctx.setMode).toHaveBeenCalledWith(Mode.Search);
    expect(ctx.setSearchQuery).toHaveBeenCalledWith("");
  });

  test("z with tmuxClient and valid pane calls zoomPane then refreshSessions", async () => {
    vi.mocked(resolveSelectedPane).mockReturnValue({
      pane: {
        paneId: "%5",
        command: "vim",
        active: true,
        zoomed: false,
        paneIndex: 0,
        window: "1",
      },
      label: "vim",
      worktreeKey: "proj/feat",
    });
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "z", noKey);
    expect(ctx.zoomPane).toHaveBeenCalledWith("%5");
    await vi.waitFor(() => {
      expect(ctx.refreshSessions).toHaveBeenCalled();
    });
  });

  test("z with tmuxClient:null is a no-op", () => {
    const ctx = makeExpCtx({ tmuxClient: null });
    handleExpandedInput(ctx, "z", noKey);
    expect(ctx.zoomPane).not.toHaveBeenCalled();
  });

  test("x with tmuxClient and valid pane sets ConfirmKill mode", () => {
    vi.mocked(resolveSelectedPane).mockReturnValue({
      pane: {
        paneId: "%5",
        command: "vim",
        active: true,
        zoomed: false,
        paneIndex: 0,
        window: "1",
      },
      label: "vim",
      worktreeKey: "proj/feat",
    });
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "x", noKey);
    expect(ctx.setMode).toHaveBeenCalledWith(
      Mode.ConfirmKill("%5", "vim", "proj/feat"),
    );
  });

  test("a calls prepareAddProjectModal in expanded mode", () => {
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "a", noKey);
    expect(ctx.prepareAddProjectModal).toHaveBeenCalled();
  });

  test("x with tmuxClient:null is a no-op", () => {
    const ctx = makeExpCtx({ tmuxClient: null });
    handleExpandedInput(ctx, "x", noKey);
    expect(ctx.setMode).not.toHaveBeenCalled();
  });
});

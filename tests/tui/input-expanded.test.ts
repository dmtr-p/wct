import type { Key } from "ink";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type ExpandedContext,
  handleExpandedInput,
} from "../../src/tui/input/expanded";
import type { NavigateContext } from "../../src/tui/input/navigate";
import {
  adjustIndexForDetailCollapse,
  resolveExpandedRightArrowAction,
  resolveSelectedPane,
} from "../../src/tui/tree-helpers";
import { Mode } from "../../src/tui/types";

vi.mock("../../src/tui/tree-helpers", () => ({
  adjustIndexForDetailCollapse: vi.fn(() => 0),
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
    prepareAddProjectModal: vi.fn(),
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
    ...overrides,
  };
}

describe("handleExpandedInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adjustIndexForDetailCollapse).mockImplementation(() => 0);
    vi.mocked(resolveExpandedRightArrowAction).mockImplementation(() => ({
      type: "noop",
    }));
    vi.mocked(resolveSelectedPane).mockImplementation(() => null);
  });

  test("left arrow calls adjustIndexForDetailCollapse and returns to Navigate", () => {
    vi.mocked(adjustIndexForDetailCollapse).mockReturnValue(2);
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "", { ...noKey, leftArrow: true });
    expect(adjustIndexForDetailCollapse).toHaveBeenCalledWith(
      ctx.treeItems,
      ctx.selectedIndex,
    );
    expect(ctx.setSelectedIndex).toHaveBeenCalledWith(2);
    expect(ctx.setMode).toHaveBeenCalledWith(Mode.Navigate);
  });

  test("escape calls adjustIndexForDetailCollapse and returns to Navigate", () => {
    vi.mocked(adjustIndexForDetailCollapse).mockReturnValue(1);
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "", { ...noKey, escape: true });
    expect(ctx.setSelectedIndex).toHaveBeenCalledWith(1);
    expect(ctx.setMode).toHaveBeenCalledWith(Mode.Navigate);
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

  test("right arrow handles expand-repo action", () => {
    vi.mocked(resolveExpandedRightArrowAction).mockReturnValue({
      type: "expand-repo",
      repoId: "repo1",
    });
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "", { ...noKey, rightArrow: true });
    expect(ctx.toggleExpanded).toHaveBeenCalledWith("repo1");
  });

  test("right arrow handles expand-worktree action", () => {
    const nextMode = Mode.Expanded("proj/feat");
    vi.mocked(resolveExpandedRightArrowAction).mockReturnValue({
      type: "expand-worktree",
      nextMode,
      nextSelectedIndex: 3,
    });
    const ctx = makeExpCtx();
    handleExpandedInput(ctx, "", { ...noKey, rightArrow: true });
    expect(ctx.setSelectedIndex).toHaveBeenCalledWith(3);
    expect(ctx.setMode).toHaveBeenCalledWith(nextMode);
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

import type { Key } from "ink";
import { describe, expect, test, vi } from "vitest";
import { RegistrationId } from "../../src/services/identities";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import {
  type ExpandedContext,
  handleExpandedInput,
} from "../../src/tui/input/expanded";
import { handleNavigateInput } from "../../src/tui/input/navigate";
import { Mode, type TreeItem } from "../../src/tui/types";
import { prRowMeta } from "../helpers/pr";

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

function makeCtx(overrides?: Partial<ExpandedContext>): ExpandedContext {
  return {
    treeItems: [],
    filteredRepos: [],
    selectedIndex: 0,
    tmuxClient: { tty: "/dev/pts/1", session: "test" },
    lifecycle: new Map(),
    setMode: vi.fn(),
    setSearchQuery: vi.fn(),
    expandWorktree: vi.fn(),
    navigateTree: vi.fn(),
    prepareOpenModal: vi.fn(),
    prepareUpModal: vi.fn(),
    handleSpaceSwitch: vi.fn(),
    handleDownSelectedWorktree: vi.fn(),
    handleCloseSelectedWorktree: vi.fn(),
    prepareRemoveProject: vi.fn(),
    prepareAddProjectModal: vi.fn(),
    refreshRepo: vi.fn(),
    panes: new Map(),
    selectTreeItem: vi.fn(),
    captureTreeReturnPosition: vi.fn(),
    zoomPane: vi.fn(() => Promise.resolve(true)),
    refreshSessions: vi.fn(() => Promise.resolve([])),
    collapseWorktree: vi.fn(),
    ...overrides,
  };
}

const repos: RepoInfo[] = ["/repos/a", "/repos/b"].map((repoPath) => ({
  id: RegistrationId(repoPath),
  repoPath,
  project: "same-name",
  profileNames: [],
  worktrees: [
    {
      branch: "feat",
      path: `${repoPath}/feat`,
      isMainWorktree: false,
      changedFiles: 0,
      sync: null,
    },
  ],
}));

const selectedItems: TreeItem[] = [
  { type: "repo", repoIndex: 1 },
  { type: "worktree", repoIndex: 1, worktreeIndex: 0 },
  {
    type: "detail",
    repoIndex: 1,
    worktreeIndex: 0,
    detailKind: "pr",
    label: "PR #1",
    meta: prRowMeta(),
  },
  {
    type: "detail",
    repoIndex: 1,
    worktreeIndex: 0,
    detailKind: "pr-title",
    label: "PR title",
    meta: { prKey: "owner/repo#1" },
  },
  {
    type: "detail",
    repoIndex: 1,
    worktreeIndex: 0,
    detailKind: "pr-fact",
    label: "Checks passed",
    meta: { prKey: "owner/repo#1", factKey: "checks" },
  },
  {
    type: "detail",
    repoIndex: 1,
    worktreeIndex: 0,
    detailKind: "pane-header",
    label: "Panes",
  },
  {
    type: "detail",
    repoIndex: 1,
    worktreeIndex: 0,
    detailKind: "pane",
    label: "shell",
    meta: { paneId: "%1", window: "0", paneIndex: 0, command: "zsh" },
  },
];

describe.each([
  ["Navigate", handleNavigateInput],
  ["Expanded", handleExpandedInput],
] as const)("shared navigation shortcuts in %s mode", (_mode, handleInput) => {
  test.each(selectedItems)(
    "r targets the selected repository for %j",
    (item) => {
      const ctx = makeCtx({
        treeItems: [{ type: "repo", repoIndex: 0 }, item],
        filteredRepos: repos,
        selectedIndex: 1,
      });

      handleInput(ctx, "r", noKey);

      expect(ctx.refreshRepo).toHaveBeenCalledExactlyOnceWith("/repos/b");
      expect(ctx.navigateTree).not.toHaveBeenCalled();
      expect(ctx.setMode).not.toHaveBeenCalled();
    },
  );

  test.each<Partial<ExpandedContext>>([
    {},
    { treeItems: [{ type: "repo", repoIndex: 0 }] },
    { treeItems: [{ type: "repo", repoIndex: 2 }], filteredRepos: repos },
    {
      treeItems: [{ type: "repo", repoIndex: 0 }],
      filteredRepos: repos,
      selectedIndex: -1,
    },
    {
      treeItems: [{ type: "repo", repoIndex: 0 }],
      filteredRepos: repos,
      selectedIndex: 1,
    },
  ])("r is a no-op with a missing selection or repository: %j", (overrides) => {
    const ctx = makeCtx(overrides);

    handleInput(ctx, "r", noKey);

    expect(ctx.refreshRepo).not.toHaveBeenCalled();
  });

  test.each([
    ["o", "prepareOpenModal"],
    ["u", "prepareUpModal"],
    ["d", "handleDownSelectedWorktree"],
    ["a", "prepareAddProjectModal"],
  ] as const)("%s invokes %s once without a tmux client", (input, action) => {
    const ctx = makeCtx({ tmuxClient: null });

    handleInput(ctx, input, noKey);

    expect(ctx[action]).toHaveBeenCalledOnce();
  });

  test.each(["delete", "backspace"] as const)(
    "%s removes a project once",
    (key) => {
      const ctx = makeCtx();

      handleInput(ctx, "", { ...noKey, [key]: true });

      expect(ctx.prepareRemoveProject).toHaveBeenCalledOnce();
    },
  );

  test("/ starts search and clears the query once", () => {
    const ctx = makeCtx();

    handleInput(ctx, "/", noKey);

    expect(ctx.setMode).toHaveBeenCalledExactlyOnceWith(Mode.Search);
    expect(ctx.setSearchQuery).toHaveBeenCalledExactlyOnceWith("");
  });

  test.each([true, false])(
    "space respects tmux client availability: %s",
    (hasClient) => {
      const ctx = makeCtx(hasClient ? {} : { tmuxClient: null });

      handleInput(ctx, " ", noKey);

      expect(ctx.handleSpaceSwitch).toHaveBeenCalledTimes(hasClient ? 1 : 0);
    },
  );
});

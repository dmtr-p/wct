import { describe, expect, test } from "vitest";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import {
  HEADER_OFFSET,
  isMouseSequence,
  type MouseActionContext,
  parseSgrMouse,
  resolveMouseAction,
} from "../../src/tui/input/mouse";
import {
  buildTreeItems,
  buildTreeRows,
  type TreeRow,
} from "../../src/tui/tree-helpers";
import { Mode, pendingKey } from "../../src/tui/types";

describe("parseSgrMouse", () => {
  test("decodes wheel up (cb=64) as wheel, NOT a click (the %4 bug is absent)", () => {
    const event = parseSgrMouse("[<64;10;5M");
    expect(event).toEqual({ kind: "wheel", dir: -1 });
    // If the parser used `cb % 4`, 64 % 4 === 0 would decode as a left press.
    expect(event?.kind).not.toBe("press");
  });

  test("decodes wheel down (cb=65) as wheel down", () => {
    expect(parseSgrMouse("[<65;10;5M")).toEqual({ kind: "wheel", dir: 1 });
  });

  test("tolerates a leading ESC on the sequence", () => {
    expect(parseSgrMouse("\x1b[<64;1;1M")).toEqual({ kind: "wheel", dir: -1 });
  });

  test("decodes a left press with 1-based col/row", () => {
    expect(parseSgrMouse("[<0;45;12M")).toEqual({
      kind: "press",
      button: "left",
      col: 45,
      row: 12,
    });
  });

  test("decodes a middle press", () => {
    expect(parseSgrMouse("[<1;3;4M")).toEqual({
      kind: "press",
      button: "middle",
      col: 3,
      row: 4,
    });
  });

  test("decodes a right press", () => {
    expect(parseSgrMouse("[<2;3;4M")).toEqual({
      kind: "press",
      button: "right",
      col: 3,
      row: 4,
    });
  });

  test("ignores a release (trailing m)", () => {
    expect(parseSgrMouse("[<0;45;12m")).toBeNull();
  });

  test("ignores motion/drag (cb & 32)", () => {
    // 32 = motion bit; 35 = motion + left button held (drag)
    expect(parseSgrMouse("[<35;45;12M")).toBeNull();
    expect(parseSgrMouse("[<32;45;12M")).toBeNull();
  });

  test("ignores additional buttons 8+ (back/forward) instead of misdecoding as left", () => {
    // cb=128 (button 8, back): would otherwise hit `(128 & 3) === 0` → "left".
    expect(parseSgrMouse("[<128;10;5M")).toBeNull();
    // cb=129 (button 9, forward).
    expect(parseSgrMouse("[<129;10;5M")).toBeNull();
  });

  test("returns null for non-mouse / malformed input", () => {
    expect(parseSgrMouse("q")).toBeNull();
    expect(parseSgrMouse("[A")).toBeNull();
    expect(parseSgrMouse("[<0;45M")).toBeNull();
    expect(parseSgrMouse("[<0;45;12X")).toBeNull();
    expect(parseSgrMouse("")).toBeNull();
    // Must be anchored: trailing junk after the final byte does not match.
    expect(parseSgrMouse("[<0;45;12Mxx")).toBeNull();
  });

  test("modifier bits (shift/meta/ctrl) on a left press still decode as left", () => {
    // cb = 0 (left) | 4 (shift) | 8 (meta) | 16 (ctrl) = 28
    expect(parseSgrMouse("[<28;5;6M")).toEqual({
      kind: "press",
      button: "left",
      col: 5,
      row: 6,
    });
  });
});

describe("isMouseSequence", () => {
  // Bug 3 regression: a single click emits BOTH a press (`M`) and a release
  // (`m`) SGR sequence. `parseSgrMouse` intentionally returns `null` for the
  // release half (and for motion/extra-button events) because they aren't
  // actionable — but the dispatcher guard must still swallow them by SHAPE,
  // not by whether they parsed to an action, or the raw escape bytes fall
  // through to mode-specific handlers (e.g. corrupting the Search query).
  test("matches a release sequence (trailing m)", () => {
    expect(isMouseSequence("\x1b[<0;45;12m")).toBe(true);
    expect(isMouseSequence("[<0;45;12m")).toBe(true);
  });

  test("matches a motion sequence (cb & 32)", () => {
    expect(isMouseSequence("\x1b[<35;10;5M")).toBe(true);
  });

  test("matches an extra-button sequence (cb & 0x80)", () => {
    expect(isMouseSequence("\x1b[<128;10;5M")).toBe(true);
  });

  test("matches an ordinary actionable press too", () => {
    expect(isMouseSequence("\x1b[<0;45;12M")).toBe(true);
  });

  test("does not match a normal keypress", () => {
    expect(isMouseSequence("\x1b[A")).toBe(false);
  });

  test("does not match plain text or empty input", () => {
    expect(isMouseSequence("q")).toBe(false);
    expect(isMouseSequence("")).toBe(false);
  });

  test("agrees with parseSgrMouse on every case where parseSgrMouse is non-null", () => {
    // Whenever parseSgrMouse resolves an actionable event, isMouseSequence
    // must also be true — parseSgrMouse being non-null is a strict subset of
    // "is a mouse sequence."
    const actionable = ["[<64;10;5M", "[<0;45;12M", "[<1;3;4M", "[<2;3;4M"];
    for (const seq of actionable) {
      expect(parseSgrMouse(seq)).not.toBeNull();
      expect(isMouseSequence(seq)).toBe(true);
    }
  });
});

describe("dispatcher guard: release/motion events never reach Search text input", () => {
  // Mirrors the exact guard shape in App.tsx's useInput dispatcher:
  //   if (isMouseSequence(input)) {
  //     const mouse = parseSgrMouse(input);
  //     if (mouse) handleMouse(mouse);
  //     return;
  //   }
  //   ... falls through to handleSearchInput(input, key) in Search mode ...
  // Bug 3 was that the OLD guard checked `parseSgrMouse(input)` truthiness
  // instead of sequence shape, so release/motion/extra-button sequences (which
  // parseSgrMouse deliberately resolves to null) fell through and got appended
  // to the search query as raw escape bytes.
  function dispatch(input: string, appendToQuery: (text: string) => void) {
    if (isMouseSequence(input)) {
      const mouse = parseSgrMouse(input);
      if (mouse) {
        // handleMouse(mouse) — not relevant to this test, Search ignores mouse
      }
      return;
    }
    // handleSearchInput's catch-all text-input branch (App.tsx ~line 445):
    // `else if (input && !key.ctrl && !key.meta) setSearchQuery((q) => q + input)`
    appendToQuery(input);
  }

  test("a click's release half does not get appended to the search query", () => {
    let query = "";
    const append = (text: string) => {
      query += text;
    };

    dispatch("a", append); // normal typed character
    dispatch("\x1b[<0;45;12M", append); // press half of a click (actionable, swallowed)
    dispatch("\x1b[<0;45;12m", append); // release half (non-actionable, must still be swallowed)
    dispatch("b", append);

    expect(query).toBe("ab");
  });

  test("motion and extra-button sequences also do not get appended", () => {
    let query = "";
    const append = (text: string) => {
      query += text;
    };

    dispatch("x", append);
    dispatch("\x1b[<35;10;5M", append); // motion
    dispatch("\x1b[<128;10;5M", append); // extra button
    dispatch("y", append);

    expect(query).toBe("xy");
  });
});

function repo(overrides: Partial<RepoInfo> & { id: string }): RepoInfo {
  return {
    id: overrides.id,
    repoPath: overrides.repoPath ?? `/tmp/${overrides.id}`,
    project: overrides.project ?? overrides.id,
    worktrees: overrides.worktrees ?? [],
    profileNames: overrides.profileNames ?? [],
    ideDefaults: overrides.ideDefaults ?? { baseNoIde: true, profileNoIde: {} },
  };
}

const repos: RepoInfo[] = [
  repo({
    id: "repo-1",
    project: "alpha",
    worktrees: [
      {
        branch: "feature/a",
        path: "/tmp/a",
        isMainWorktree: false,
        changedFiles: 0,
        sync: { ahead: 0, behind: 0 },
      },
      {
        branch: "feature/b",
        path: "/tmp/b",
        isMainWorktree: false,
        changedFiles: 0,
        sync: { ahead: 0, behind: 0 },
      },
    ],
  }),
  repo({
    id: "repo-2",
    project: "beta",
    worktrees: [
      {
        branch: "feature/c",
        path: "/tmp/c",
        isMainWorktree: false,
        changedFiles: 0,
        sync: { ahead: 0, behind: 0 },
      },
    ],
  }),
];

function buildCtx(
  mode: Mode,
  expandedWorktreeKey: string | null,
  overrides?: Partial<MouseActionContext>,
): MouseActionContext {
  const expandedRepos = new Set(["repo-1", "repo-2"]);
  const treeItems = buildTreeItems({
    repos,
    expandedRepos,
    expandedWorktreeKey,
    prData: new Map(),
    panes: new Map(),
    jumpToPane: () => undefined,
  });
  const rows = buildTreeRows({
    items: treeItems,
    repos,
    expandedRepos,
    expandedWorktreeKey,
    pendingActions: new Map(),
  });
  return {
    mode,
    rows,
    effectiveScrollOffset: 0,
    viewportRows: rows.length,
    treeItems,
    repos,
    expandedWorktreeKey,
    ...overrides,
  };
}

describe("resolveMouseAction", () => {
  test("wheel scrolls only; selection untouched", () => {
    const ctx = buildCtx(Mode.Navigate, null);
    expect(resolveMouseAction({ kind: "wheel", dir: -1 }, ctx)).toEqual({
      kind: "scroll",
      delta: -1,
    });
    expect(resolveMouseAction({ kind: "wheel", dir: 1 }, ctx)).toEqual({
      kind: "scroll",
      delta: 1,
    });
  });

  test("left-click in Navigate selects the hit row", () => {
    const ctx = buildCtx(Mode.Navigate, null);
    // rows: [repo-1(0), wt-a(1), wt-b(2), repo-2(3), wt-c(4)]
    // SGR row = viewportRow + 1 + HEADER_OFFSET. viewportRow 1 → wt-a (item 1).
    const sgrRow = 1 + 1 + HEADER_OFFSET;
    expect(
      resolveMouseAction(
        { kind: "press", button: "left", col: 3, row: sgrRow },
        ctx,
      ),
    ).toEqual({ kind: "select", itemIndex: 1 });
  });

  test("non-left buttons resolve to none", () => {
    const ctx = buildCtx(Mode.Navigate, null);
    const sgrRow = 1 + 1 + HEADER_OFFSET;
    expect(
      resolveMouseAction(
        { kind: "press", button: "right", col: 3, row: sgrRow },
        ctx,
      ),
    ).toEqual({ kind: "none" });
    expect(
      resolveMouseAction(
        { kind: "press", button: "middle", col: 3, row: sgrRow },
        ctx,
      ),
    ).toEqual({ kind: "none" });
  });

  test("clicks on header rows resolve to none", () => {
    const ctx = buildCtx(Mode.Navigate, null);
    // SGR rows 1 and 2 are the header + spacer (viewportRow < 0).
    expect(
      resolveMouseAction(
        { kind: "press", button: "left", col: 1, row: 1 },
        ctx,
      ),
    ).toEqual({ kind: "none" });
    expect(
      resolveMouseAction(
        { kind: "press", button: "left", col: 1, row: 2 },
        ctx,
      ),
    ).toEqual({ kind: "none" });
  });

  test("clicks below the viewport (StatusBar region) resolve to none", () => {
    const ctx = buildCtx(Mode.Navigate, null, { viewportRows: 3 });
    // viewportRow 3 is >= viewportRows (3) → out of range.
    const sgrRow = 3 + 1 + HEADER_OFFSET;
    expect(
      resolveMouseAction(
        { kind: "press", button: "left", col: 1, row: sgrRow },
        ctx,
      ),
    ).toEqual({ kind: "none" });
  });

  test("Expanded: within-subtree click selects and stays", () => {
    const key = pendingKey("alpha", "feature/a");
    const ctx = buildCtx(Mode.Expanded(key), key);
    // items: repo-1(0), wt-a(1), [pr detail if any], wt-b, repo-2, wt-c.
    // Clicking wt-a (the expanded worktree itself, item 1, row index 1).
    const sgrRow = 1 + 1 + HEADER_OFFSET;
    expect(
      resolveMouseAction(
        { kind: "press", button: "left", col: 3, row: sgrRow },
        ctx,
      ),
    ).toEqual({ kind: "select", itemIndex: 1 });
  });

  test("Expanded: outside-subtree click exits to Navigate and selects", () => {
    const key = pendingKey("alpha", "feature/a");
    const ctx = buildCtx(Mode.Expanded(key), key);
    // Click the sibling worktree feature/b. Find its row index in rows.
    const rowIndex = ctx.rows.findIndex((r: TreeRow) => {
      if (r.itemIndex == null) return false;
      const item = ctx.treeItems[r.itemIndex];
      return item?.type === "worktree" && item.worktreeIndex === 1;
    });
    const itemIndex = ctx.rows[rowIndex]?.itemIndex as number;
    const sgrRow = rowIndex + 1 + HEADER_OFFSET;
    expect(
      resolveMouseAction(
        { kind: "press", button: "left", col: 3, row: sgrRow },
        ctx,
      ),
    ).toEqual({ kind: "selectAndExitExpanded", itemIndex });
  });

  test("non-interactive modes (Search/modals/confirm) resolve to none", () => {
    for (const mode of [
      Mode.Search,
      Mode.OpenModal,
      Mode.AddProjectModal,
    ] as Mode[]) {
      const ctx = buildCtx(mode, null);
      expect(resolveMouseAction({ kind: "wheel", dir: -1 }, ctx)).toEqual({
        kind: "none",
      });
      const sgrRow = 1 + 1 + HEADER_OFFSET;
      expect(
        resolveMouseAction(
          { kind: "press", button: "left", col: 3, row: sgrRow },
          ctx,
        ),
      ).toEqual({ kind: "none" });
    }
  });

  test("hit-test round-trip: every visible row maps back to the item it renders", () => {
    const ctx = buildCtx(Mode.Navigate, null, {
      effectiveScrollOffset: 1,
      viewportRows: 3,
    });
    // Visible rows are rows[1], rows[2], rows[3] at viewportRow 0,1,2.
    for (let viewportRow = 0; viewportRow < ctx.viewportRows; viewportRow++) {
      const sgrRow = viewportRow + 1 + HEADER_OFFSET;
      const expectedRow = ctx.rows[ctx.effectiveScrollOffset + viewportRow];
      const action = resolveMouseAction(
        { kind: "press", button: "left", col: 1, row: sgrRow },
        ctx,
      );
      if (expectedRow?.itemIndex == null) {
        expect(action).toEqual({ kind: "none" });
      } else {
        expect(action).toEqual({
          kind: "select",
          itemIndex: expectedRow.itemIndex,
        });
      }
    }
  });
});

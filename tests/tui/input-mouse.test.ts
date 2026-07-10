import { describe, expect, test } from "vitest";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import {
  detectDoubleClick,
  HEADER_OFFSET,
  isMouseSequence,
  isX10MousePrefix,
  type MouseActionContext,
  mouseClickTargetId,
  parseSgrMouse,
  resolveMouseAction,
  resolveTreeDoubleClickAction,
  splitMouseSequences,
} from "../../src/tui/input/mouse";
import {
  buildTreeItems,
  buildTreeRows,
  type TreeRow,
} from "../../src/tui/tree-helpers";
import { Mode, type PaneInfo, pendingKey } from "../../src/tui/types";

describe("isX10MousePrefix", () => {
  test("matches the legacy X10 report prefix, with or without leading ESC", () => {
    // Ink terminates the CSI at the `M` final byte and strips each event's
    // leading ESC, so the prefix arrives as "[M" (or "\x1b[M" defensively).
    expect(isX10MousePrefix("[M")).toBe(true);
    expect(isX10MousePrefix("\x1b[M")).toBe(true);
  });

  test("rejects SGR sequences and ordinary input", () => {
    expect(isX10MousePrefix("[<0;5;5M")).toBe(false);
    expect(isX10MousePrefix("M")).toBe(false);
    expect(isX10MousePrefix("[Mx")).toBe(false);
    expect(isX10MousePrefix("q")).toBe(false);
    expect(isX10MousePrefix("")).toBe(false);
  });
});

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

  test("ignores horizontal wheel (cb=66 wheel-left, cb=67 wheel-right)", () => {
    // Tilt wheels / horizontal trackpad swipes must not decode by bit 0 as
    // vertical scrolling (66 → up, 67 → down) — they are not vertical events.
    expect(parseSgrMouse("[<66;10;5M")).toBeNull();
    expect(parseSgrMouse("[<67;10;5M")).toBeNull();
  });

  test("ignores horizontal wheel with modifier bits set", () => {
    // shift=4, ctrl=16 on top of 66/67 keep the low 2 bits horizontal.
    expect(parseSgrMouse("[<70;10;5M")).toBeNull(); // 66 + shift
    expect(parseSgrMouse("[<83;10;5M")).toBeNull(); // 67 + ctrl
  });

  test("still decodes vertical wheel with modifier bits set", () => {
    expect(parseSgrMouse("[<68;10;5M")).toEqual({ kind: "wheel", dir: -1 }); // 64 + shift
    expect(parseSgrMouse("[<81;10;5M")).toEqual({ kind: "wheel", dir: 1 }); // 65 + ctrl
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

describe("double-click actions", () => {
  test("requires two clicks on the same target within the interval", () => {
    const first = detectDoubleClick(null, "wt:alpha/a", 1000);
    expect(first.isDoubleClick).toBe(false);
    expect(detectDoubleClick(first.history, "wt:alpha/a", 1300)).toEqual({
      isDoubleClick: true,
      history: null,
    });
    expect(
      detectDoubleClick(first.history, "wt:alpha/b", 1300).isDoubleClick,
    ).toBe(false);
    expect(
      detectDoubleClick(first.history, "wt:alpha/a", 1500).isDoubleClick,
    ).toBe(false);
  });

  test("treats different wrapped lines of one item as different targets", () => {
    const first = detectDoubleClick(
      null,
      mouseClickTargetId("detail:alpha/pr-1", 4),
      1000,
    );
    expect(
      detectDoubleClick(
        first.history,
        mouseClickTargetId("detail:alpha/pr-1", 5),
        1200,
      ).isDoubleClick,
    ).toBe(false);
  });

  test("toggles worktrees and activates only PR or pane details", () => {
    const repo = {
      id: "repo-1",
      repoPath: "/tmp/alpha",
      project: "alpha",
      worktrees: [
        {
          branch: "feature/a",
          path: "/tmp/a",
          isMainWorktree: false,
          changedFiles: 0,
          sync: null,
        },
      ],
      profileNames: [],
      ideDefaults: { baseNoIde: true, profileNoIde: {} },
    } satisfies RepoInfo;
    const worktree = {
      type: "worktree",
      repoIndex: 0,
      worktreeIndex: 0,
    } as const;
    const key = pendingKey("alpha", "feature/a");
    expect(resolveTreeDoubleClickAction(worktree, [repo], new Set())).toEqual({
      type: "expand-worktree",
      worktreeKey: key,
    });
    expect(
      resolveTreeDoubleClickAction(worktree, [repo], new Set([key])),
    ).toEqual({
      type: "collapse-worktree",
      worktreeKey: key,
    });

    const action = () => undefined;
    const pr = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pr",
      label: "PR #1",
      meta: { rollupState: null },
      action,
    } as const;
    expect(resolveTreeDoubleClickAction(pr, [repo], new Set())).toEqual({
      type: "activate-detail",
      action,
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

  // Multi-sequence strings — defense-in-depth, NOT the normal stdin path.
  // Ink 7.1's input parser (ink/build/input-parser.js) splits every complete
  // CSI sequence in a stdin chunk into its OWN useInput event and strips the
  // leading ESC per event, so a concatenated string can only reach useInput
  // via Ink's bracketed-paste fallback (emitInput(event.paste) when no paste
  // listener is registered) carrying mouse-shaped pasted text — or a future
  // change in Ink's delivery model. The guard accepts one-or-more sequences
  // so that path can never leak escape bytes into text inputs either.
  test("matches a concatenated press+release+release string (paste-fallback shape)", () => {
    expect(isMouseSequence("[<0;12;38M\x1b[<0;12;38m\x1b[<0;1;1m")).toBe(true);
  });

  test("matches a concatenated string whether or not each sequence keeps its ESC", () => {
    expect(isMouseSequence("\x1b[<65;1;1M\x1b[<65;1;1M")).toBe(true);
    expect(isMouseSequence("[<65;1;1M[<65;1;1M")).toBe(true);
  });

  test("does NOT match a mixed string — a keystroke merged with a sequence is keyboard input", () => {
    // Semantics (documented on isMouseSequence): input is swallowed as mouse
    // only when it is ENTIRELY mouse sequences. Swallowing a mixed string
    // would eat the 'a' keystroke. (Accepted trade-off, also documented
    // there: a paste that is EXACTLY mouse-shaped tokens IS swallowed.)
    expect(isMouseSequence("a\x1b[<0;5;5M")).toBe(false);
    expect(isMouseSequence("a[<0;5;5M")).toBe(false);
    expect(isMouseSequence("\x1b[<0;5;5Mx")).toBe(false);
    expect(isMouseSequence("[<0;5;5M[<0;5;5")).toBe(false); // truncated tail
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

describe("splitMouseSequences", () => {
  // Pins the ordering/multi-event contract for multi-sequence strings (the
  // paste-fallback shape — see the delivery-model note above). This pure
  // suite is the real coverage for the splitter; the app-mouse-wiring tests
  // exercise guard integration end-to-end but Ink splits their stdin writes
  // into per-sequence events before the splitter is ever needed.
  test("splits a concatenated string into single sequences, in order", () => {
    expect(splitMouseSequences("[<0;12;38M\x1b[<0;12;38m\x1b[<0;1;1m")).toEqual(
      ["[<0;12;38M", "\x1b[<0;12;38m", "\x1b[<0;1;1m"],
    );
  });

  test("a single sequence yields itself", () => {
    expect(splitMouseSequences("\x1b[<65;1;1M")).toEqual(["\x1b[<65;1;1M"]);
  });

  test("each split sequence is consumable by parseSgrMouse — two wheel-downs yield two scroll events in order", () => {
    const events = splitMouseSequences("\x1b[<65;1;1M\x1b[<65;1;1M").map(
      parseSgrMouse,
    );
    expect(events).toEqual([
      { kind: "wheel", dir: 1 },
      { kind: "wheel", dir: 1 },
    ]);
  });

  test("press+release split: press parses, release parses to null (non-actionable but swallowed)", () => {
    const events = splitMouseSequences("\x1b[<0;12;38M\x1b[<0;12;38m").map(
      parseSgrMouse,
    );
    expect(events).toEqual([
      { kind: "press", button: "left", col: 12, row: 38 },
      null,
    ]);
  });

  test("returns [] for mixed or non-mouse input (never swallows keystrokes)", () => {
    expect(splitMouseSequences("a\x1b[<0;5;5M")).toEqual([]);
    expect(splitMouseSequences("q")).toEqual([]);
    expect(splitMouseSequences("")).toEqual([]);
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
  panes: Map<string, PaneInfo[]> = new Map(),
): MouseActionContext {
  const expandedRepos = new Set(["repo-1", "repo-2"]);
  const expandedWorktreeKeys = expandedWorktreeKey
    ? new Set([expandedWorktreeKey])
    : new Set<string>();
  const treeItems = buildTreeItems({
    repos,
    expandedWorktreeKeys,
    prData: new Map(),
    panes,
    jumpToPane: () => undefined,
  });
  const rows = buildTreeRows({
    items: treeItems,
    repos,
    expandedRepos,
    expandedWorktreeKeys,
    pendingActions: new Map(),
  });
  return {
    mode,
    rows,
    effectiveScrollOffset: 0,
    viewportRows: rows.length,
    treeItems,
    repos,
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
    ).toEqual({ kind: "select", itemIndex: 1, rowIndex: 1 });
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
    ).toEqual({ kind: "select", itemIndex: 1, rowIndex: 1 });
  });

  test("Expanded: outside-subtree click selects without collapsing", () => {
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
    ).toEqual({ kind: "select", itemIndex, rowIndex });
  });

  test("a click on an inert pane-header row resolves to none, but a pane row selects (keyboard parity)", () => {
    const key = pendingKey("alpha", "feature/a");
    // feature/a's session name is formatSessionName(basename("/tmp/a")) = "a".
    const panes = new Map<string, PaneInfo[]>([
      [
        "a",
        [
          {
            paneId: "%1",
            paneIndex: 0,
            command: "vim",
            window: "0",
            zoomed: false,
            active: true,
          },
        ],
      ],
    ]);
    const ctx = buildCtx(Mode.Expanded(key), key, undefined, panes);

    const headerItemIndex = ctx.treeItems.findIndex(
      (item) => item.type === "detail" && item.detailKind === "pane-header",
    );
    expect(headerItemIndex).toBeGreaterThan(-1);
    const headerRowIndex = ctx.rows.findIndex(
      (r: TreeRow) => r.itemIndex === headerItemIndex,
    );
    expect(headerRowIndex).toBeGreaterThan(-1);

    // createNavigateTree skips pane-header rows for the keyboard, so a mouse
    // click on one must be a no-op — not a selection the keyboard could
    // never reach.
    expect(
      resolveMouseAction(
        {
          kind: "press",
          button: "left",
          col: 3,
          row: headerRowIndex + 1 + HEADER_OFFSET,
        },
        ctx,
      ),
    ).toEqual({ kind: "none" });

    // A pane row directly below the header IS selectable by mouse.
    const paneItemIndex = ctx.treeItems.findIndex(
      (item) => item.type === "detail" && item.detailKind === "pane",
    );
    const paneRowIndex = ctx.rows.findIndex(
      (r: TreeRow) => r.itemIndex === paneItemIndex,
    );
    expect(
      resolveMouseAction(
        {
          kind: "press",
          button: "left",
          col: 3,
          row: paneRowIndex + 1 + HEADER_OFFSET,
        },
        ctx,
      ),
    ).toEqual({
      kind: "select",
      itemIndex: paneItemIndex,
      rowIndex: paneRowIndex,
    });
  });

  test("Expanded: a click on a wrapped PR's continuation row selects the PR", () => {
    const branch = "feature/a";
    const key = pendingKey("alpha", branch);
    const prData = new Map([
      [
        key,
        {
          number: 1,
          title: "a very long pull request title that certainly wraps",
          state: "OPEN" as const,
          headRefName: branch,
          rollupState: "success" as const,
        },
      ],
    ]);
    const expandedRepos = new Set(["repo-1", "repo-2"]);
    const treeItems = buildTreeItems({
      repos,
      expandedWorktreeKeys: new Set([key]),
      prData,
      panes: new Map(),
      jumpToPane: () => undefined,
    });
    const rows = buildTreeRows({
      items: treeItems,
      repos,
      expandedRepos,
      expandedWorktreeKeys: new Set([key]),
      pendingActions: new Map(),
      maxWidth: 40, // forces the PR title to wrap
    });
    const ctx: MouseActionContext = {
      mode: Mode.Expanded(key),
      rows,
      effectiveScrollOffset: 0,
      viewportRows: rows.length,
      treeItems,
      repos,
    };

    // The continuation row carries the PR's own itemIndex, so clicking the
    // wrapped line resolves to selecting the PR (within the expanded subtree).
    const contRowIndex = rows.findIndex(
      (r: TreeRow) => r.kind === "detail-pr-cont",
    );
    expect(contRowIndex).toBeGreaterThan(-1);
    const prItemIndex = rows[contRowIndex]?.itemIndex as number;
    // The primary PR row precedes it and maps to the same item.
    expect(rows[contRowIndex - 1]).toMatchObject({
      kind: "detail",
      itemIndex: prItemIndex,
    });

    expect(
      resolveMouseAction(
        {
          kind: "press",
          button: "left",
          col: 12,
          row: contRowIndex + 1 + HEADER_OFFSET,
        },
        ctx,
      ),
    ).toEqual({
      kind: "select",
      itemIndex: prItemIndex,
      rowIndex: contRowIndex,
    });
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
          rowIndex: ctx.effectiveScrollOffset + viewportRow,
        });
      }
    }
  });
});

// Regression tests for Bug 1 (click-to-exit-Expanded selects the wrong
// worktree) and Bug 2 (background refresh re-anchors a wheel-scrolled
// viewport) that render the REAL exported `App` from `src/tui/App.tsx` — not
// a hand-copied reimplementation of its effects — so reverting the fix in
// App.tsx actually fails these tests.
//
// Service mocks and the Ink render harness live in tests/tui/app-harness.tsx
// (shared with tests/tui/app-review-fixes.test.tsx); see the mocking-strategy
// note there.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  githubFixtures,
  makeWorktree,
  registryItems,
  renderApp,
  resetHarnessFixtures,
  selectedLine,
  sendKeys,
  setTallWorktrees,
  sgrPress,
  sgrRelease,
  sgrRowFor,
  sgrWheel,
  tick,
  worktreeFixtures,
} from "./app-harness";

const { App } = await import("../../src/tui/App");

describe("App.tsx mouse wiring (bug 1 + bug 2 regressions, real App)", () => {
  let homeDir: string;
  let repoPath: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "wct-app-mouse-home-"));
    repoPath = mkdtempSync(join(tmpdir(), "wct-app-mouse-repo-"));
    // useRefresh's fs.watch(`${HOME}/.wct`) call throws synchronously (caught
    // and silently swallowed) if the directory does not exist AT MOUNT TIME —
    // it does not retroactively pick up a directory created after the watch()
    // call. Create it up front so tests that trigger a real background
    // refresh via a file write under it actually land.
    mkdirSync(join(homeDir, ".wct"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    resetHarnessFixtures();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  function worktree(branch: string) {
    return makeWorktree(repoPath, branch);
  }

  test("keyboard input breaks a pending double-click pair", async () => {
    registryItems.items = [
      { id: "repo-1", repo_path: repoPath, project: "alpha" },
    ];
    worktreeFixtures.byRepoPath.set(repoPath, [
      worktree("main"),
      worktree("feature/a"),
    ]);

    const rendered = await renderApp(<App />);
    try {
      await tick(20);
      await sendKeys(rendered.stdin, "\x1b[B");
      await sendKeys(rendered.stdin, "\x1b[B");

      const row = sgrRowFor(2);
      await sendKeys(rendered.stdin, sgrPress(3, row));
      await sendKeys(rendered.stdin, "\x1b[C");
      expect(selectedLine(rendered.lines())).toContain("▼");

      await sendKeys(rendered.stdin, sgrPress(3, row));
      expect(selectedLine(rendered.lines())).toContain("▼");
    } finally {
      rendered.unmount();
    }
  });

  describe("Bug 1: click-to-exit-Expanded selects the clicked sibling, not the old identity", () => {
    test("without a detail row on the expanded worktree", async () => {
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      worktreeFixtures.byRepoPath.set(repoPath, [
        worktree("main"),
        worktree("feature/a"),
        worktree("feature/b"),
      ]);

      const rendered = await renderApp(<App />);
      try {
        await tick(20);
        expect(rendered.output()).toContain("feature/a");
        expect(rendered.output()).toContain("feature/b");

        // Rows after auto-expand: repo-1(0), main(1), feature/a(2),
        // feature/b(3). Select feature/a with the keyboard, then expand it
        // with the real right-arrow handler (handleNavigateInput).
        await sendKeys(rendered.stdin, "\x1b[B"); // down: repo -> main
        await sendKeys(rendered.stdin, "\x1b[B"); // down: main -> feature/a
        await sendKeys(rendered.stdin, "\x1b[C"); // right: expand feature/a

        expect(selectedLine(rendered.lines())).toContain("feature/a");

        // No PR/pane data for feature/a → no detail row while Expanded, so
        // rows still map 1:1 to items: repo-1(0), main(1), feature/a(2),
        // feature/b(3). Click feature/b (viewportRow 3) to exit Expanded.
        const sgrRow = sgrRowFor(3);
        await sendKeys(rendered.stdin, sgrPress(3, sgrRow));
        await sendKeys(rendered.stdin, sgrRelease(3, sgrRow));

        // Bug 1: without the fix, identity recovery snaps the cursor back to
        // feature/a. With the fix, the clicked feature/b stays selected.
        const line = selectedLine(rendered.lines());
        expect(line).toContain("feature/b");
        expect(line).not.toContain("feature/a");
      } finally {
        rendered.unmount();
      }
    });

    test("with a detail row on the expanded worktree (PR row shifts every later index)", async () => {
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      worktreeFixtures.byRepoPath.set(repoPath, [
        worktree("main"),
        worktree("feature/a"),
        worktree("feature/b"),
      ]);
      // feature/a has a PR — while Expanded on feature/a, one extra "detail"
      // row renders beneath it, shifting feature/b's row down by one. This
      // is exactly the scenario adjustIndexForDetailCollapse must correct
      // for when the click resolves against the pre-collapse item indices.
      githubFixtures.prsByRepoPath.set(repoPath, [
        {
          number: 7,
          title: "Add thing",
          state: "OPEN",
          headRefName: "feature/a",
          rollupState: null,
        },
      ]);

      const rendered = await renderApp(<App />);
      try {
        await tick(20);
        expect(rendered.output()).toContain("feature/a");

        await sendKeys(rendered.stdin, "\x1b[B"); // repo -> main
        await sendKeys(rendered.stdin, "\x1b[B"); // main -> feature/a
        await sendKeys(rendered.stdin, "\x1b[C"); // expand feature/a

        // Fetch PRs for real via the actual keyboard-reachable refresh path
        // (pressing "r" in Navigate calls ctx.refreshRepo -> refreshGitHub ->
        // GitHubService.use(listPrs); see the githubFixtures comment in
        // app-harness.tsx for why this is the only real path to populate PR
        // data here). "r" is Navigate-only, so collapse out of Expanded
        // first, then re-expand.
        await sendKeys(rendered.stdin, "\x1b[D"); // left: collapse to Navigate
        await sendKeys(rendered.stdin, "r"); // refresh PRs for repo "alpha"
        await tick(15);
        await sendKeys(rendered.stdin, "\x1b[C"); // right: re-expand feature/a

        // Rows while Expanded: repo-1(0), main(1), feature/a(2), PR-detail(3),
        // feature/b(4). Confirm the PR detail row actually rendered before
        // clicking, so this test is exercising the index-shift it claims to.
        expect(rendered.output()).toContain("PR #7");

        const sgrRow = sgrRowFor(4);
        await sendKeys(rendered.stdin, sgrPress(3, sgrRow));
        await sendKeys(rendered.stdin, sgrRelease(3, sgrRow));

        // Bug 1a: without adjustIndexForDetailCollapse, the raw clicked
        // itemIndex (4) is used post-collapse, but after the PR detail row
        // is removed feature/b sits at index 3 — so an unadjusted click would
        // select the wrong row (or the row after feature/b, if any existed).
        // With the fix, feature/b is selected correctly.
        const line = selectedLine(rendered.lines());
        expect(line).toContain("feature/b");
        expect(line).not.toContain("feature/a");
        expect(line).not.toContain("main");
      } finally {
        rendered.unmount();
      }
    });

    test("selects the clicked row even when its post-collapse index equals the cursor's (PR #104 r3511242204)", async () => {
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      worktreeFixtures.byRepoPath.set(repoPath, [
        worktree("main"),
        worktree("feature/a"),
        worktree("feature/b"),
        worktree("feature/c"),
      ]);
      githubFixtures.prsByRepoPath.set(repoPath, [
        {
          number: 7,
          title: "Add thing",
          state: "OPEN",
          headRefName: "feature/a",
          rollupState: null,
        },
      ]);

      const rendered = await renderApp(<App />);
      try {
        await tick(20);
        expect(rendered.output()).toContain("feature/c");

        await sendKeys(rendered.stdin, "\x1b[B"); // repo -> main
        await sendKeys(rendered.stdin, "\x1b[B"); // main -> feature/a
        await sendKeys(rendered.stdin, "r"); // fetch PRs (Navigate-only key)
        await tick(15);
        await sendKeys(rendered.stdin, "\x1b[C"); // right: expand feature/a
        expect(rendered.output()).toContain("PR #7");

        // Items while Expanded: repo-1(0), main(1), feature/a(2),
        // PR-detail(3), feature/b(4), feature/c(5). Walk the cursor PAST the
        // detail block onto feature/b — Expanded ↑/↓ navigates the whole
        // tree without exiting the mode.
        await sendKeys(rendered.stdin, "\x1b[B"); // feature/a -> PR detail
        await sendKeys(rendered.stdin, "\x1b[B"); // PR detail -> feature/b
        expect(selectedLine(rendered.lines())).toContain("feature/b");

        // Click feature/c (item 5). Collapsing removes the PR detail row, so
        // feature/c's adjusted index is 4 — exactly the cursor's pre-collapse
        // index. setSelectedIndex(4) is then a no-op and selectionChanged
        // stays false; without pre-storing the clicked item's identity, the
        // recovery effect would treat the collapse as a background tree
        // change and snap the cursor back to feature/b.
        const sgrRow = sgrRowFor(5);
        await sendKeys(rendered.stdin, sgrPress(3, sgrRow));
        await sendKeys(rendered.stdin, sgrRelease(3, sgrRow));

        const line = selectedLine(rendered.lines());
        expect(line).toContain("feature/c");
        expect(line).not.toContain("feature/b");
      } finally {
        rendered.unmount();
      }
    });
  });

  describe("Bug 2: background refresh (new `rows`/`repos` ref, same selectedIndex) must not re-anchor a wheel-scrolled viewport", () => {
    test("a background refresh (repos ref change, selectedIndex unchanged) does not move the viewport", async () => {
      setTallWorktrees(repoPath, 40);

      // A short terminal forces a small viewport so the tree scrolls.
      const rendered = await renderApp(<App />, 14);
      try {
        await tick(20);
        expect(rendered.output()).toContain("main");

        // Selection stays on the repo row (index 0, never moved). Wheel-scroll
        // down repeatedly so the viewport moves away from the selection —
        // this is the intended PRD §3 behaviour (wheel scrolls independent of
        // selection).
        for (let i = 0; i < 15; i++) {
          await sendKeys(rendered.stdin, sgrWheel(1), 1);
        }
        await tick(5);

        const beforeRefresh = rendered.lines();
        // The selected row (repo-1, still index 0) must have scrolled out of
        // the visible window.
        expect(selectedLine(beforeRefresh)).toBeUndefined();
        // Capture which worktree branches are visible right before the
        // simulated background refresh.
        const visibleBefore = beforeRefresh.filter((l) =>
          /feature\/\d+/.test(l),
        );
        expect(visibleBefore.length).toBeGreaterThan(0);

        // Trigger a REAL background refresh through useRefresh's fs.watch
        // path (not a simulated re-render): useRefresh watches
        // `${HOME}/.wct/` for `.db`/`-wal` changes with a 150ms debounce and
        // calls refreshAll -> refreshRegistry -> useRegistry's refresh(),
        // which re-fetches from RegistryService/WorktreeService. Our mocks
        // re-read their fixture maps fresh on every call and return brand-new
        // arrays each time — exactly like the real services — so this is a
        // content-identical, reference-different refresh, which is the exact
        // condition useRegistry.ts triggers on (it has no equality bail-out
        // before calling setRepos).
        const wctDir = join(homeDir, ".wct");
        mkdirSync(wctDir, { recursive: true });
        writeFileSync(join(wctDir, "registry.db"), "trigger");
        await new Promise((resolve) => setTimeout(resolve, 250)); // past the 150ms debounce
        await tick(10);

        const afterRefresh = rendered.lines();
        // Bug 2: without the selectionChanged gate, a background refresh
        // that only changes object identity (not content) would re-fire the
        // auto-scroll effect and snap the viewport back to the (unchanged)
        // selection, discarding the wheel scroll. With the fix, the viewport
        // must still show the same scrolled-to region.
        expect(selectedLine(afterRefresh)).toBeUndefined();
        const visibleAfter = afterRefresh.filter((l) => /feature\/\d+/.test(l));
        expect(visibleAfter).toEqual(visibleBefore);
      } finally {
        rendered.unmount();
      }
    });

    test("entering Search after a wheel scroll (selection already at index 0) resets the viewport to the first match", async () => {
      setTallWorktrees(repoPath, 40);

      const rendered = await renderApp(<App />, 14);
      try {
        await tick(20);
        expect(rendered.output()).toContain("main");

        // Selection stays on the repo row (index 0, never moved). Wheel-scroll
        // the viewport away so the selected row is off-screen.
        for (let i = 0; i < 15; i++) {
          await sendKeys(rendered.stdin, sgrWheel(1), 1);
        }
        await tick(5);
        expect(selectedLine(rendered.lines())).toBeUndefined();

        // Enter Search and type a query that still matches many rows. The
        // cursor reset (setSelectedIndex(0)) is a no-op — selectedIndex is
        // already 0 — so `selectionChanged` stays false and the keep-visible
        // effect never fires; without the explicit scroll reset in the
        // searchQueryChanged branch, Search would open with the selected
        // first match scrolled off-screen and no visible cursor.
        await sendKeys(rendered.stdin, "/");
        await sendKeys(rendered.stdin, "f");
        await tick(5);

        const line = selectedLine(rendered.lines());
        expect(line).toBeDefined();
        expect(line).toContain("alpha");
      } finally {
        rendered.unmount();
      }
    });

    test("two wheel-downs written as one stdin chunk scroll twice end-to-end (guard integration)", async () => {
      setTallWorktrees(repoPath, 40);

      const rendered = await renderApp(<App />, 14);
      try {
        await tick(20);
        // Rows: repo-1(0), main(1), feature/0(2), feature/1(3), …
        expect(rendered.output()).toContain("main");

        // Write BOTH wheel-down sequences in ONE stdin chunk. Ink 7.1's input
        // parser splits the chunk into TWO per-sequence useInput events before
        // dispatch, so this verifies the guarded dispatcher handles every
        // event of a coalesced write end-to-end — NOT splitMouseSequences
        // (that multi-sequence splitter only runs on Ink's paste-fallback
        // path and is pinned by the pure tests in input-mouse.test.ts). Each
        // event must scroll one row: offset 0 → 2, so the first visible row
        // becomes feature/0 and main scrolls off; if only one event were
        // acted on, offset would be 1 and main would still be visible.
        await sendKeys(rendered.stdin, sgrWheel(1) + sgrWheel(1));
        await tick(5);

        const lines = rendered.lines();
        expect(lines.some((l) => l.includes("feature/0"))).toBe(true);
        expect(lines.some((l) => l.includes("main"))).toBe(false);
      } finally {
        rendered.unmount();
      }
    });

    test("a click's press+release written as one chunk leaves the Search query clean (guard integration)", async () => {
      setTallWorktrees(repoPath, 5);

      const rendered = await renderApp(<App />, 20);
      try {
        await tick(20);
        expect(rendered.output()).toContain("main");

        await sendKeys(rendered.stdin, "/"); // enter Search
        // A real click always emits press + release; write both in one stdin
        // chunk. Ink splits them into two per-sequence useInput events, so
        // this verifies the shape-based guard swallows BOTH halves in Search
        // mode end-to-end — in particular the release, which parseSgrMouse
        // resolves to null but must never fall through to the query handler.
        await sendKeys(rendered.stdin, sgrPress(3, 3) + sgrRelease(3, 3));
        await sendKeys(rendered.stdin, "f");
        await tick(5);

        // Query must be exactly "f" — still matching the feature/* rows. Had
        // either half leaked into the query, nothing would match and no
        // selection cursor would render.
        const line = selectedLine(rendered.lines());
        expect(line).toBeDefined();
        expect(line).toContain("alpha");
      } finally {
        rendered.unmount();
      }
    });

    test("a wheel right after a no-nudge click is not undone (selectionChanged falling edge)", async () => {
      setTallWorktrees(repoPath, 40);

      const rendered = await renderApp(<App />, 14);
      try {
        await tick(20);
        expect(rendered.output()).toContain("main");

        // Wheel the viewport down so the selection (repo, row 0) is
        // off-screen, then click the TOP visible row (feature/3, row 5 at
        // offset 5). The click is a deliberate selection change but needs NO
        // nudge — the row is already visible — so the keep-visible effect's
        // functional update returns the same offset and React bails without
        // an extra commit that would consume the selectionChanged edge.
        for (let i = 0; i < 5; i++) {
          await sendKeys(rendered.stdin, sgrWheel(1), 1);
        }
        await tick(5);
        expect(selectedLine(rendered.lines())).toBeUndefined();

        await sendKeys(rendered.stdin, sgrPress(3, sgrRowFor(0)));
        expect(selectedLine(rendered.lines())).toContain("feature/3");

        // The very next wheel tick scrolls the just-clicked selection off the
        // top. This commit re-fires the keep-visible effect purely via the
        // FALLING edge of selectionChanged (true -> false) while the
        // visibility ref still says "was visible" — without requiring the
        // row/viewport to have actually changed, the effect would re-anchor
        // and snap the offset straight back, eating the wheel tick.
        await sendKeys(rendered.stdin, sgrWheel(1), 1);
        await tick(5);

        expect(selectedLine(rendered.lines())).toBeUndefined();
      } finally {
        rendered.unmount();
      }
    });

    test("a genuine selectedIndex change still nudges the viewport", async () => {
      setTallWorktrees(repoPath, 40);

      const rendered = await renderApp(<App />, 14);
      try {
        await tick(20);

        for (let i = 0; i < 15; i++) {
          await sendKeys(rendered.stdin, sgrWheel(1), 1);
        }
        await tick(5);
        expect(selectedLine(rendered.lines())).toBeUndefined();

        // Click a visible row — a deliberate selection change must nudge the
        // viewport to include it.
        const sgrRow = sgrRowFor(0);
        await sendKeys(rendered.stdin, sgrPress(3, sgrRow));

        const line = selectedLine(rendered.lines());
        expect(line).toBeDefined();
      } finally {
        rendered.unmount();
      }
    });
  });

  describe("Bug: a viewport shrink must not hide the selection (PR #104 r3512096209)", () => {
    test("resizing the terminal shorter keeps a bottom-row selection visible", async () => {
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      worktreeFixtures.byRepoPath.set(repoPath, [
        worktree("main"),
        ...Array.from({ length: 40 }, (_, i) => worktree(`feature/${i}`)),
      ]);

      const rendered = await renderApp(<App />, 14);
      try {
        await tick(20);
        expect(rendered.output()).toContain("main");

        // Walk the cursor well past the first viewport; the keep-visible
        // effect pins it to the bottom visible row (rows are 1:1 with items
        // here, so 12 downs land on feature/10 at row index 12).
        for (let i = 0; i < 12; i++) {
          await sendKeys(rendered.stdin, "\x1b[B", 2);
        }
        await tick(5);
        expect(selectedLine(rendered.lines())).toContain("feature/10");

        // Shrink the terminal by two rows. selectedIndex is unchanged, so
        // the keep-visible effect's selectionChanged gate alone skips it,
        // and the recovery effect's clamp can only DECREASE the offset (a
        // shrink raises the max offset) — without the viewport-shrink signal
        // the selected bottom row falls below the window and the cursor
        // disappears until the next navigation key.
        rendered.stdout.rows = 12;
        rendered.stdout.emit("resize");
        await tick(10);

        expect(selectedLine(rendered.lines())).toContain("feature/10");
      } finally {
        rendered.unmount();
      }
    });

    test("a shrink with the selection already wheel-scrolled off-screen leaves the viewport alone", async () => {
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      worktreeFixtures.byRepoPath.set(repoPath, [
        worktree("main"),
        ...Array.from({ length: 40 }, (_, i) => worktree(`feature/${i}`)),
      ]);

      const rendered = await renderApp(<App />, 14);
      try {
        await tick(20);
        expect(rendered.output()).toContain("main");

        // Selection stays on the repo row (index 0); wheel the viewport away
        // so the selected row is off-screen — the deliberate PRD §3 state.
        for (let i = 0; i < 15; i++) {
          await sendKeys(rendered.stdin, sgrWheel(1), 1);
        }
        await tick(5);
        const before = rendered.lines();
        expect(selectedLine(before)).toBeUndefined();
        const firstVisibleBefore = before.find((l) => /feature\/\d+/.test(l));

        // A shrink must NOT re-anchor to a selection that was already
        // off-screen — the wheel-scrolled region stays put (its top row is
        // unchanged; the shrink only trims rows off the bottom).
        rendered.stdout.rows = 12;
        rendered.stdout.emit("resize");
        await tick(10);

        const after = rendered.lines();
        expect(selectedLine(after)).toBeUndefined();
        expect(after.find((l) => /feature\/\d+/.test(l))).toEqual(
          firstVisibleBefore,
        );
      } finally {
        rendered.unmount();
      }
    });
  });

  describe("Bug: row reflow above the selection must not hide it (PR #104 r3530858752)", () => {
    // 52 chars: the PR label ("PR #7: <title> (OPEN)", 66 chars) renders on
    // ONE row at 100 columns (92-column label budget after the 8-column
    // indent/selector chrome) but wraps onto TWO at 60 columns (52-column
    // budget) — so narrowing the terminal shifts every row below the PR down
    // by one while selectedIndex and viewportRows stay unchanged.
    const wrappingTitle =
      "Keep the selection visible when rows above it reflow";

    function setupRepoWithPr(featureCount: number) {
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      worktreeFixtures.byRepoPath.set(repoPath, [
        worktree("main"),
        worktree("feature/0"),
        ...Array.from({ length: featureCount }, (_, i) =>
          worktree(`feature/${i + 1}`),
        ),
      ]);
      githubFixtures.prsByRepoPath.set(repoPath, [
        {
          number: 7,
          title: wrappingTitle,
          state: "OPEN",
          headRefName: "feature/0",
          rollupState: null,
        },
      ]);
    }

    test("a PR title wrapping after a width resize keeps a bottom-row selection visible", async () => {
      setupRepoWithPr(20);

      const rendered = await renderApp(<App />, 14, 100);
      try {
        await tick(20);
        expect(rendered.output()).toContain("main");

        // Put the PR detail row in the tree: select feature/0, fetch PRs via
        // the real Navigate-only "r" path, then expand it. Items while
        // Expanded: repo-1(0), main(1), feature/0(2), PR-detail(3),
        // feature/1(4), … — Expanded ↑/↓ then walks the whole tree without
        // exiting the mode, so the detail row stays rendered.
        await sendKeys(rendered.stdin, "\x1b[B"); // repo -> main
        await sendKeys(rendered.stdin, "\x1b[B"); // main -> feature/0
        await sendKeys(rendered.stdin, "r"); // fetch PRs for repo "alpha"
        await tick(15);
        await sendKeys(rendered.stdin, "\x1b[C"); // right: expand feature/0
        expect(rendered.output()).toContain("PR #7");

        // Walk the cursor well past the first viewport so the keep-visible
        // effect pins it to the BOTTOM visible row (12 downs from feature/0
        // land on feature/11 at row index 14, past the PR detail row).
        for (let i = 0; i < 12; i++) {
          await sendKeys(rendered.stdin, "\x1b[B", 2);
        }
        await tick(5);
        expect(selectedLine(rendered.lines())).toContain("feature/11");

        // Narrow the terminal. The PR label above the window wraps onto a
        // second row, pushing the selection's visual row down by one while
        // selectedIndex AND viewportRows stay unchanged — so neither the
        // selectionChanged gate nor a viewport-shrink signal fires, and the
        // recovery effect's clamp only ever DECREASES the offset. Without
        // reflow handling the bottom-pinned cursor falls below the window
        // and disappears until the next navigation key.
        rendered.stdout.columns = 60;
        rendered.stdout.emit("resize");
        await tick(10);

        expect(selectedLine(rendered.lines())).toContain("feature/11");

        // Prove the reflow actually happened — otherwise this test passes
        // vacuously if the resize ever stops propagating `columns` (the
        // visible worktree set is identical pre/post resize by construction).
        // Wheel back to the top: the PR label must now wrap onto a
        // continuation row ("reflow (OPEN)" on its own line, no "PR #7").
        for (let i = 0; i < 10; i++) {
          await sendKeys(rendered.stdin, sgrWheel(-1), 1);
        }
        await tick(5);
        const contLine = rendered
          .lines()
          .find((l) => l.includes("reflow (OPEN)"));
        expect(contLine).toBeDefined();
        expect(contLine).not.toContain("PR #7");
      } finally {
        rendered.unmount();
      }
    });

    test("a reflow with the selection already wheel-scrolled off-screen leaves the viewport alone", async () => {
      setupRepoWithPr(40);

      const rendered = await renderApp(<App />, 14, 100);
      try {
        await tick(20);
        expect(rendered.output()).toContain("main");

        await sendKeys(rendered.stdin, "\x1b[B"); // repo -> main
        await sendKeys(rendered.stdin, "\x1b[B"); // main -> feature/0
        await sendKeys(rendered.stdin, "r"); // fetch PRs for repo "alpha"
        await tick(15);
        await sendKeys(rendered.stdin, "\x1b[C"); // right: expand feature/0
        expect(rendered.output()).toContain("PR #7");

        // Park the cursor BELOW the PR detail row (feature/1, row 4) so the
        // wrap will move its visual row, then wheel the viewport away — the
        // deliberate PRD §3 state with the selection off-screen above.
        await sendKeys(rendered.stdin, "\x1b[B"); // feature/0 -> PR detail
        await sendKeys(rendered.stdin, "\x1b[B"); // PR detail -> feature/1
        for (let i = 0; i < 15; i++) {
          await sendKeys(rendered.stdin, sgrWheel(1), 1);
        }
        await tick(5);
        expect(selectedLine(rendered.lines())).toBeUndefined();

        // The reflow moves the selection's visual row (4 -> 5), but the
        // selection was already off-screen — re-anchoring would discard the
        // wheel scroll, so the viewport must stay put.
        rendered.stdout.columns = 60;
        rendered.stdout.emit("resize");
        await tick(10);

        expect(selectedLine(rendered.lines())).toBeUndefined();
      } finally {
        rendered.unmount();
      }
    });
  });

  describe("Bug: narrow terminals must not wrap bottom chrome (PR #104 r3520956519)", () => {
    test("the frame stays within terminal rows when an error exceeds the width", async () => {
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      worktreeFixtures.byRepoPath.set(repoPath, [
        worktree("main"),
        ...Array.from({ length: 20 }, (_, i) => worktree(`feature/${i}`)),
      ]);

      // At 45 columns the tmux-error line ("No tmux client found — …", 49
      // chars, always shown in this clientless test env) does not fit. Without
      // truncation Ink wraps it onto a second row, the 14-row budget (2 header
      // + 11 viewport + 1 error) under-counts, and the overflowing layout
      // clips rows and misaligns mouse hit-testing.
      const rendered = await renderApp(<App />, 14, 45);
      try {
        await tick(20);
        expect(rendered.output()).toContain("main");

        const frame = rendered.lines();
        while (
          frame.length > 0 &&
          (frame[frame.length - 1] ?? "").trim() === ""
        ) {
          frame.pop();
        }
        expect(frame.length).toBeLessThanOrEqual(14);
        // The full budgeted layout must actually be present: the last of the
        // 11 viewport rows (repo, main, feature/0..8) and the single error
        // line must both have survived.
        expect(frame.some((l) => l.includes("feature/8"))).toBe(true);
        expect(frame[frame.length - 1]).toContain("No tmux client found");
      } finally {
        rendered.unmount();
      }
    });
  });
});

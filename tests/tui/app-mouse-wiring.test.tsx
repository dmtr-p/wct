import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  triggerRefresh,
  worktreeFixtures,
} from "./app-harness";

const { App } = await import("../../src/tui/App");

describe("App mouse selection and viewport behavior", () => {
  let homeDir: string;
  let repoPath: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "wct-app-mouse-home-"));
    repoPath = mkdtempSync(join(tmpdir(), "wct-app-mouse-repo-"));
    // fs.watch requires the directory to exist when App mounts.
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
    const fixture = makeWorktree(repoPath, branch);
    // These cases assume healthy worktrees with no unknown-status row.
    mkdirSync(fixture.path, { recursive: true });
    return fixture;
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

  describe("clicking a sibling while another worktree is expanded", () => {
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
        // feature/b(3). Click feature/b at viewport row 3.
        const sgrRow = sgrRowFor(3);
        await sendKeys(rendered.stdin, sgrPress(3, sgrRow));
        await sendKeys(rendered.stdin, sgrRelease(3, sgrRow));

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
      // Expanding feature/a adds a PR detail row beneath it, shifting
      // feature/b's row down by one. Hit-testing must account for that row.
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

        // "r" is Navigate-only, so collapse out of Expanded before refreshing
        // the fixture PRs through the keyboard action, then re-expand.
        await sendKeys(rendered.stdin, "\x1b[D"); // left: collapse to Navigate
        await sendKeys(rendered.stdin, "r"); // refresh PRs for repo "alpha"
        await tick(15);
        await sendKeys(rendered.stdin, "\x1b[C"); // right: re-expand feature/a

        // Rows while Expanded: repo-1(0), main(1), feature/a(2), PR-detail(3),
        // feature/b(4). Confirm the PR detail row actually rendered before
        // clicking, so this test is exercising the index-shift it claims to.
        expect(rendered.output()).toContain("#7");

        const sgrRow = sgrRowFor(4);
        await sendKeys(rendered.stdin, sgrPress(3, sgrRow));
        await sendKeys(rendered.stdin, sgrRelease(3, sgrRow));

        // Selecting the sibling preserves feature/a's expansion and PR row.
        expect(rendered.lines().join("\n")).toContain("#7");
        const line = selectedLine(rendered.lines());
        expect(line).toContain("feature/b");
        expect(line).not.toContain("feature/a");
        expect(line).not.toContain("main");
      } finally {
        rendered.unmount();
      }
    });

    test("selects the next sibling after navigating past expanded PR details", async () => {
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
        expect(rendered.output()).toContain("#7");

        // Items while Expanded: repo-1(0), main(1), feature/a(2),
        // PR-detail(3), feature/b(4), feature/c(5). Walk the cursor PAST the
        // detail block onto feature/b — Expanded ↑/↓ navigates the whole
        // tree without exiting the mode.
        await sendKeys(rendered.stdin, "\x1b[B"); // feature/a -> PR detail
        await sendKeys(rendered.stdin, "\x1b[B"); // PR detail -> feature/b
        expect(selectedLine(rendered.lines())).toContain("feature/b");

        // Click feature/c at item 5. Selection recovery must retain the
        // clicked identity instead of returning to feature/b.
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

  describe("background refresh preserves a wheel-scrolled viewport", () => {
    test("a background refresh (repos ref change, selectedIndex unchanged) does not move the viewport", async () => {
      setTallWorktrees(repoPath, 40);

      // A short terminal forces a small viewport so the tree scrolls.
      const rendered = await renderApp(<App />, 14);
      try {
        await tick(20);
        expect(rendered.output()).toContain("main");

        // Scroll the selection off-screen to distinguish viewport preservation
        // from automatic selection reveal.
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

        await triggerRefresh();
        await tick(10);

        const afterRefresh = rendered.lines();
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

        // The selection is already at index 0; changing the query must still
        // reveal the first match.
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

        // Write BOTH wheel-down sequences in ONE stdin chunk. The adapter
        // observes both reports before Ink 8 discards them. Each event must
        // scroll one row: offset 0 → 2, so the first visible row
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
        // chunk. Ink 8 discards both sequences; the adapter must deliver the
        // press separately without letting either half reach the query.
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

    test("wheel scrolling after selecting an already visible row preserves the new offset", async () => {
      setTallWorktrees(repoPath, 40);

      const rendered = await renderApp(<App />, 14);
      try {
        await tick(20);
        expect(rendered.output()).toContain("main");

        // Select the top visible row at offset 5. The click changes selection
        // without needing to move the viewport.
        for (let i = 0; i < 5; i++) {
          await sendKeys(rendered.stdin, sgrWheel(1), 1);
        }
        await tick(5);
        expect(selectedLine(rendered.lines())).toBeUndefined();

        await sendKeys(rendered.stdin, sgrPress(3, sgrRowFor(0)));
        expect(selectedLine(rendered.lines())).toContain("feature/3");

        // The next wheel tick must be able to scroll the clicked row off-screen.
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

  describe("viewport shrink preserves selection visibility", () => {
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

        // Twelve downs put feature/10 on the bottom visible row.
        for (let i = 0; i < 12; i++) {
          await sendKeys(rendered.stdin, "\x1b[B", 2);
        }
        await tick(5);
        expect(selectedLine(rendered.lines())).toContain("feature/10");

        // Shrinking must keep a previously visible selection on-screen even
        // when its item index has not changed.
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

        // Scroll the selection off-screen before resizing.
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

  describe("row reflow above the selection preserves its visibility", () => {
    // The expanded PR title fits at 100 columns and wraps at 60 columns,
    // shifting every row below it while selection and viewport size stay fixed.
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
        expect(rendered.output()).toContain("#7");
        await sendKeys(rendered.stdin, "\x1b[B"); // select PR row
        await sendKeys(rendered.stdin, "\x1b[C"); // show full title and facts

        // Walk past the expanded PR facts to pin feature/11 to the bottom.
        for (
          let i = 0;
          i < 30 && !selectedLine(rendered.lines())?.includes("feature/11");
          i++
        ) {
          await sendKeys(rendered.stdin, "\x1b[B", 2);
        }
        await tick(5);
        expect(selectedLine(rendered.lines())).toContain("feature/11");

        // Narrowing wraps the PR title above the viewport, shifting the selected
        // visual row while its item index and the viewport height stay unchanged.
        rendered.stdout.columns = 60;
        rendered.stdout.emit("resize");
        await tick(10);

        expect(selectedLine(rendered.lines())).toContain("feature/11");

        // Prove the reflow actually happened — otherwise this test passes
        // vacuously if the resize ever stops propagating `columns` (the
        // visible worktree set is identical pre/post resize by construction).
        // Wheel back to the top: the expanded title has a continuation row.
        for (let i = 0; i < 10; i++) {
          await sendKeys(rendered.stdin, sgrWheel(-1), 1);
        }
        await tick(5);
        const contLine = rendered.lines().find((l) => l.includes("reflow"));
        expect(contLine).toBeDefined();
        expect(contLine).not.toContain("#7");
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
        expect(rendered.output()).toContain("#7");
        await sendKeys(rendered.stdin, "\x1b[B"); // select PR row
        await sendKeys(rendered.stdin, "\x1b[C"); // show full title and facts

        // Select below the PR title so reflow shifts its visual row, then scroll
        // the selection off-screen before resizing.
        for (
          let i = 0;
          i < 10 && !selectedLine(rendered.lines())?.includes("feature/1");
          i++
        ) {
          await sendKeys(rendered.stdin, "\x1b[B");
        }
        expect(selectedLine(rendered.lines())).toContain("feature/1");
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

  describe("narrow terminals keep bottom chrome on one line", () => {
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

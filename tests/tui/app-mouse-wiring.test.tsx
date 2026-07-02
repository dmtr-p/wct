// Regression tests for Bug 1 (click-to-exit-Expanded selects the wrong
// worktree) and Bug 2 (background refresh re-anchors a wheel-scrolled
// viewport) that render the REAL exported `App` from `src/tui/App.tsx` — not
// a hand-copied reimplementation of its effects — so reverting the fix in
// App.tsx actually fails these tests.
//
// Mocking strategy mirrors the established pattern in this test suite
// (tests/tui/use-tmux.test.ts, tests/tui/session-actions.test.ts,
// tests/tui/modal-actions.test.ts): mock each `XService.use(selector)` to
// call `selector` synchronously against a controllable fake service object
// (so it returns a plain Promise, not a real Effect), and mock
// `tuiRuntime.runPromise`/`runSync` as a transparent pass-through. Since the
// `.use()` mocks already resolve the "effect" argument to a real Promise or
// plain value before it reaches `runPromise`, the pass-through is enough —
// the one caller that does NOT go through a `.use()` seam (`loadConfig` in
// `getIdeDefaults`) is wrapped in a try/catch with a safe fallback in the
// real code, so passing it through unresolved is harmless.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Worktree } from "../../src/services/worktree-service";

const runtimeMock = vi.hoisted(() => ({
  runPromise: vi.fn((effect: unknown) => Promise.resolve(effect)),
  // The `.use()` mocks below already resolve the "effect" argument to a
  // plain value before it reaches here, so this is a transparent pass-through
  // (like runPromise), not a stub that discards its argument.
  runSync: vi.fn((effect: unknown) => effect),
}));

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: runtimeMock,
  runTuiSilentPromise: (effect: unknown) => runtimeMock.runPromise(effect),
}));

// --- RegistryService: repos controllable per test via registryItems. ---
const registryItems = vi.hoisted(() => ({
  items: [] as Array<{ id: string; repo_path: string; project: string }>,
}));

vi.mock("../../src/services/registry-service", () => ({
  RegistryService: {
    use: (selector: (svc: unknown) => unknown) =>
      selector({
        listRepos: () => Promise.resolve(registryItems.items),
      }),
  },
}));

// --- WorktreeService: worktrees keyed by repoPath, controllable per test. ---
const worktreeFixtures = vi.hoisted(() => ({
  byRepoPath: new Map<string, Worktree[]>(),
}));

vi.mock("../../src/services/worktree-service", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/services/worktree-service")
  >("../../src/services/worktree-service");
  return {
    ...actual,
    WorktreeService: {
      use: (selector: (svc: unknown) => unknown) =>
        selector({
          listWorktrees: (repoPath: string) =>
            Promise.resolve(worktreeFixtures.byRepoPath.get(repoPath) ?? []),
          getDefaultBranch: () => Promise.resolve("main"),
          getChangedFileCount: () => Promise.resolve(0),
          getAheadBehind: () =>
            Promise.resolve({ ahead: 0, behind: 0 }) as Promise<{
              ahead: number;
              behind: number;
            } | null>,
        }),
    },
  };
});

// --- TmuxService: no client, no sessions — App renders without tmux. ---
vi.mock("../../src/services/tmux", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/services/tmux")
  >("../../src/services/tmux");
  return {
    ...actual,
    TmuxService: {
      use: (selector: (svc: unknown) => unknown) =>
        selector({
          listClients: () => Promise.resolve([]),
          listSessions: () => Promise.resolve(null),
          listPanes: () => Promise.resolve([]),
        }),
    },
  };
});

// --- GitHubService + PrCacheService: no PRs by default. useGitHub never
// fetches on a fresh App mount for the current repo (its mount effect reads
// `repos`, which is always `[]` on the very first render — before
// useRegistry's async listRepos() resolves — and its callback identity never
// changes, so it doesn't re-run once repos populate). The one REAL,
// keyboard-reachable path that calls GitHubService.listPrs is pressing "r" in
// Navigate mode (src/tui/input/navigate.ts calls ctx.refreshRepo), so a test
// that needs a PR row drives that key rather than relying on mount timing.
const githubFixtures = vi.hoisted(() => ({
  prsByRepoPath: new Map<
    string,
    Array<{
      number: number;
      title: string;
      state: "OPEN" | "MERGED" | "CLOSED";
      headRefName: string;
      rollupState: "success" | "failure" | "pending" | null;
    }>
  >(),
}));

vi.mock("../../src/services/github-service", () => ({
  GitHubService: {
    use: (selector: (svc: unknown) => unknown) =>
      selector({
        listPrs: (repoPath: string) =>
          Promise.resolve(githubFixtures.prsByRepoPath.get(repoPath) ?? []),
      }),
  },
}));

vi.mock("../../src/services/pr-cache-service", () => ({
  PrCacheService: {
    use: (selector: (svc: unknown) => unknown) =>
      selector({
        getCached: () => null,
        setCached: () => Promise.resolve(),
        setError: () => Promise.resolve(),
      }),
  },
}));

const { App } = await import("../../src/tui/App");

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
  ref: () => NodeJS.ReadStream;
  unref: () => NodeJS.ReadStream;
};

function createStdoutStdin(rows: number) {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 100;
  stdout.rows = rows;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return { stdout, stdin };
}

function stripAnsi(value: string) {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (char === "" && value.charAt(i + 1) === "[") {
      i += 2;
      while (i < value.length && !/[\x40-\x7E]/.test(value.charAt(i))) {
        i += 1;
      }
      continue;
    }
    output += char;
  }
  return output;
}

async function tick(count = 1) {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function renderApp(node: React.ReactElement, termRows = 32) {
  const { stdout, stdin } = createStdoutStdin(termRows);
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });

  const { render } = await import("ink");
  const instance = render(node, {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    stdin,
    // The last full frame Ink wrote, split into lines, ANSI stripped.
    lines: () => stripAnsi(chunks[chunks.length - 1] ?? "").split("\n"),
    output: () => stripAnsi(chunks.join("\n")),
    unmount() {
      instance.unmount();
    },
  };
}

async function sendKeys(stdin: NodeJS.ReadStream, sequence: string, ticks = 5) {
  stdin.write(sequence);
  await tick(ticks);
}

function sgrPress(col: number, row: number): string {
  return `\x1b[<0;${col};${row}M`;
}

function sgrRelease(col: number, row: number): string {
  return `\x1b[<0;${col};${row}m`;
}

function sgrWheel(dir: 1 | -1): string {
  // 64 = wheel up (dir -1), 65 = wheel down (dir 1)
  const cb = dir === -1 ? 64 : 65;
  return `\x1b[<${cb};1;1M`;
}

// Mirrors App.tsx's TOP_CHROME_ROWS (== HEADER_OFFSET): the `wct` header line
// + a blank spacer line above the tree viewport.
const HEADER_OFFSET = 2;

function sgrRowFor(viewportRow: number): number {
  return viewportRow + 1 + HEADER_OFFSET;
}

/** The single rendered line containing the ❯ selection cursor, or undefined. */
function selectedLine(lines: string[]): string | undefined {
  return lines.find((l) => l.includes("❯"));
}

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
    registryItems.items = [];
    worktreeFixtures.byRepoPath.clear();
    githubFixtures.prsByRepoPath.clear();
    runtimeMock.runPromise.mockClear();
    runtimeMock.runSync.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  function worktree(branch: string): Worktree {
    return {
      path: join(repoPath, branch.replaceAll("/", "-")),
      branch,
      commit: "abc123",
      isBare: false,
    };
  }

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
        // GitHubService.use(listPrs); see the githubFixtures comment above
        // for why this is the only real path to populate PR data here). "r"
        // is Navigate-only, so collapse out of Expanded first, then re-expand.
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
  });

  describe("Bug 2: background refresh (new `rows`/`repos` ref, same selectedIndex) must not re-anchor a wheel-scrolled viewport", () => {
    function setTallWorktrees(n: number) {
      const worktrees: Worktree[] = [
        worktree("main"),
        ...Array.from({ length: n }, (_, i) => worktree(`feature/${i}`)),
      ];
      worktreeFixtures.byRepoPath.set(repoPath, worktrees);
    }

    test("a background refresh (repos ref change, selectedIndex unchanged) does not move the viewport", async () => {
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      setTallWorktrees(40);

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
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      setTallWorktrees(40);

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
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      setTallWorktrees(40);

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
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      setTallWorktrees(5);

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

    test("a genuine selectedIndex change still nudges the viewport", async () => {
      registryItems.items = [
        { id: "repo-1", repo_path: repoPath, project: "alpha" },
      ];
      setTallWorktrees(40);

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
});

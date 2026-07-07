// Regression tests for the PR #104 review fixes that render the REAL exported
// `App` from `src/tui/App.tsx` through Ink's actual input pipeline:
//
// 1. Opening a true modal (`o`) and cancelling must not wipe a wheel-scrolled
//    viewport (the old `viewportRows = rows.length` modal branch clamped the
//    scroll offset to 0 and re-anchored to the selection on cancel).
// 2. A true modal over a tree taller than the terminal renders intact instead
//    of being garbled by the overflowing full tree (overflowY clipping).
// 3. Ctrl+C writes MOUSE_DISABLE BEFORE Ink turns raw mode off (same ordering
//    fix as the `q` path; requires exitOnCtrlC to be off so the app owns \x03).
// 4. Legacy X10 mouse bytes (terminal honors ?1000 but not ?1006) are
//    swallowed by the guard instead of typing junk into the Search query —
//    including payload bytes ≥ 0x80 that UTF-8 decode merges into ONE
//    multi-byte character (the guard must count raw bytes, not characters).
// 5. Horizontal wheel events (SGR cb 66/67) do not scroll the viewport.
// 6. A multi-line bracketed paste into Search is collapsed onto one query row
//    (StatusBar budgets the query line as exactly one terminal row).
//
// Service mocks and the Ink render harness live in tests/tui/app-harness.tsx
// (shared with tests/tui/app-mouse-wiring.test.tsx); see the mocking-strategy
// note there.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  makeWorktree,
  registryItems,
  renderApp,
  resetHarnessFixtures,
  selectedLine,
  sendKeys,
  sgrWheel,
  tick,
  worktreeFixtures,
} from "./app-harness";

const { App } = await import("../../src/tui/App");
const { MOUSE_DISABLE } = await import("../../src/tui/hooks/useMouse");

describe("App.tsx review fixes (real App)", () => {
  let homeDir: string;
  let repoPath: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "wct-app-review-home-"));
    repoPath = mkdtempSync(join(tmpdir(), "wct-app-review-repo-"));
    mkdirSync(join(homeDir, ".wct"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    resetHarnessFixtures();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  function setTallWorktrees(n: number) {
    worktreeFixtures.byRepoPath.set(repoPath, [
      makeWorktree(repoPath, "main"),
      ...Array.from({ length: n }, (_, i) =>
        makeWorktree(repoPath, `feature/${i}`),
      ),
    ]);
    registryItems.items = [
      { id: "repo-1", repo_path: repoPath, project: "alpha" },
    ];
  }

  test("opening and cancelling a modal preserves a wheel-scrolled viewport", async () => {
    setTallWorktrees(40);

    const rendered = await renderApp(<App />, 14);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");

      // Selection stays on the repo row (index 0); wheel the viewport away so
      // the selected row is off-screen — the deliberate PRD §3 state.
      for (let i = 0; i < 15; i++) {
        await sendKeys(rendered.stdin, sgrWheel(1), 1);
      }
      await tick(5);
      const before = rendered.lines();
      expect(selectedLine(before)).toBeUndefined();
      const visibleBefore = before.filter((l) => /feature\/\d+/.test(l));
      expect(visibleBefore.length).toBeGreaterThan(0);

      // Open the OpenModal and cancel straight out of it. The old modal
      // branch set viewportRows = rows.length, whose clamp effect zeroed the
      // persistent scrollOffset — after Esc the viewport re-anchored to the
      // selection and the reading position (visibleBefore) was gone.
      await sendKeys(rendered.stdin, "o");
      expect(rendered.output()).toContain("Select mode");
      // A lone ESC sits in Ink's pending-escape buffer for 20ms (it could be
      // the start of a CSI sequence) before it is flushed as the escape key —
      // wait past that flush, not just event-loop ticks.
      await sendKeys(rendered.stdin, "\x1b"); // esc: cancel back to Navigate
      await new Promise((resolve) => setTimeout(resolve, 60));
      await tick(5);

      const after = rendered.lines();
      expect(selectedLine(after)).toBeUndefined();
      expect(after.filter((l) => /feature\/\d+/.test(l))).toEqual(
        visibleBefore,
      );
    } finally {
      rendered.unmount();
    }
  });

  test("a modal over a tree taller than the terminal renders intact (no garble)", async () => {
    setTallWorktrees(40);

    const rendered = await renderApp(<App />, 14);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");

      await sendKeys(rendered.stdin, "o");

      const frame = rendered.lines();
      while (
        frame.length > 0 &&
        (frame[frame.length - 1] ?? "").trim() === ""
      ) {
        frame.pop();
      }
      // The whole frame must fit the terminal (the overflowing tree clips
      // inside its own box instead of painting over the modal)...
      expect(frame.length).toBeLessThanOrEqual(14);
      // ...the header must survive (the garbled layout corrupted it to " ct")...
      expect(frame[0]).toBe("wct");
      // ...and the modal must be fully present: title on its top border and
      // an intact bottom border, in order.
      const topBorder = frame.findIndex((l) => l.includes("Select mode"));
      const bottomBorder = frame.findIndex((l) => l.includes("╰"));
      expect(topBorder).toBeGreaterThan(-1);
      expect(frame[topBorder]).toContain("╭");
      expect(bottomBorder).toBeGreaterThan(topBorder);
    } finally {
      rendered.unmount();
    }
  });

  test("Ctrl+C disables mouse reporting BEFORE raw mode is turned off, then exits", async () => {
    setTallWorktrees(3);

    const rendered = await renderApp(<App />, 20);
    await tick(20);

    await sendKeys(rendered.stdin, "\x03");
    await rendered.instance.waitUntilExit();

    const disableIndex = rendered.events.findIndex(
      (e) => e.kind === "write" && e.data.includes(MOUSE_DISABLE),
    );
    const rawModeOffIndex = rendered.events.findIndex(
      (e) => e.kind === "rawmode" && e.mode === false,
    );
    // Without the fix Ink's own \x03 shortcut runs handleExit first: raw mode
    // goes off during handleExit and MOUSE_DISABLE only lands later, in the
    // React unmount cleanup — echoing any in-flight reports onto the shell.
    expect(disableIndex).toBeGreaterThan(-1);
    expect(rawModeOffIndex).toBeGreaterThan(-1);
    expect(disableIndex).toBeLessThan(rawModeOffIndex);
  });

  test("legacy X10 mouse bytes are swallowed instead of typed into the Search query", async () => {
    setTallWorktrees(5);

    const rendered = await renderApp(<App />, 20);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");

      await sendKeys(rendered.stdin, "/"); // enter Search
      // An X10 left-click press+release at col 5, row 12: ESC [ M + 3 payload
      // bytes each. Ink splits each report into an "[M" CSI event plus a
      // separate printable payload event; the payload (" %," / "#%,") is what
      // leaked into the query before the guard armed a byte-counted swallow.
      await sendKeys(rendered.stdin, "\x1b[M %,\x1b[M#%,");
      await sendKeys(rendered.stdin, "f");
      await tick(5);

      // The query must be exactly "f": still matching feature/* rows, with
      // the query line rendered as "/f" and no payload junk appended.
      expect(rendered.lines().some((l) => l.trim() === "/f")).toBe(true);
      expect(selectedLine(rendered.lines())).toBeDefined();
    } finally {
      rendered.unmount();
    }
  });

  test("X10 payload bytes that UTF-8 decode merges into one character do not desync the guard", async () => {
    setTallWorktrees(5);

    const rendered = await renderApp(<App />, 20);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");

      await sendKeys(rendered.stdin, "/"); // enter Search
      // An X10 left-click press+release at col 163, row 137: the coordinate
      // bytes are col+32 = 0xC3 and row+32 = 0xA9, which stdin's UTF-8
      // decode merges into the SINGLE character "é" — the 3-byte payload
      // arrives as the two-character string " é". A guard that decrements by
      // string length drains only 2 of the 3 armed bytes, stays armed, and
      // eats the next real keystroke; the byte-counted guard drains exactly.
      await sendKeys(rendered.stdin, "\x1b[M é\x1b[M#é");
      await sendKeys(rendered.stdin, "f");
      await tick(5);

      // The "f" typed after the click must reach the query (rendered "/f"),
      // and no payload characters may leak in.
      expect(rendered.lines().some((l) => l.trim() === "/f")).toBe(true);
      expect(selectedLine(rendered.lines())).toBeDefined();
    } finally {
      rendered.unmount();
    }
  });

  test("X10 payload bytes that are INVALID UTF-8 are swallowed, not leaked to the query", async () => {
    setTallWorktrees(5);

    const rendered = await renderApp(<App />, 20);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");

      await sendKeys(rendered.stdin, "/"); // enter Search
      // An X10 left-click press+release at col 100, row 8: the col byte is
      // col+32 = 0x84 — a lone UTF-8 continuation byte, which stdin's decode
      // replaces with U+FFFD (THREE UTF-8 bytes standing in for ONE raw
      // byte). Counting the replacement char at its encoded width overshoots
      // the 3-byte counter, drops the guard, and leaks "�(" into the query;
      // counting it as the single raw byte it replaced drains exactly. The
      // bytes must be written RAW (a JS string would re-encode 0x84 as two
      // valid UTF-8 bytes and never produce the replacement char).
      rendered.stdin.write(
        Buffer.from([
          0x1b,
          0x5b,
          0x4d,
          0x20,
          0x84,
          0x28, // press:   ESC [ M 0x20 0x84 0x28
          0x1b,
          0x5b,
          0x4d,
          0x23,
          0x84,
          0x28, // release: ESC [ M 0x23 0x84 0x28
        ]),
      );
      await tick(5);
      await sendKeys(rendered.stdin, "f");
      await tick(5);

      expect(rendered.lines().some((l) => l.trim() === "/f")).toBe(true);
      expect(selectedLine(rendered.lines())).toBeDefined();
    } finally {
      rendered.unmount();
    }
  });

  test("a multi-line bracketed paste into Search stays on one query row", async () => {
    setTallWorktrees(5);

    const rendered = await renderApp(<App />, 20);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");

      await sendKeys(rendered.stdin, "/"); // enter Search
      // Ink's bracketed-paste fallback (no paste listener registered)
      // delivers the pasted text as ONE input event, embedded newline
      // included. statusBarRowCount(Search) budgets the query as exactly one
      // row and wrap="truncate" cannot remove newlines — un-collapsed, the
      // paste would render an extra chrome row and desync mouse hit-testing.
      await sendKeys(rendered.stdin, "\x1b[200~feat\nure\x1b[201~");
      await tick(5);

      const lines = rendered.lines();
      // The newline is collapsed to a space on a single query row...
      expect(lines.some((l) => l.trim() === "/feat ure")).toBe(true);
      // ...and no second line carries the paste's tail.
      expect(lines.some((l) => l.trim() === "ure")).toBe(false);
    } finally {
      rendered.unmount();
    }
  });

  test("horizontal wheel events (cb 66/67) do not scroll the viewport", async () => {
    setTallWorktrees(40);

    const rendered = await renderApp(<App />, 14);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");
      const before = rendered.lines();

      // A horizontal trackpad swipe burst: wheel-left and wheel-right ticks.
      await sendKeys(rendered.stdin, "\x1b[<66;1;1M\x1b[<67;1;1M\x1b[<66;1;1M");
      await tick(5);

      // Before the fix these decoded as vertical wheel via bit 0 and jerked
      // the viewport; now the frame must be unchanged.
      expect(rendered.lines()).toEqual(before);
    } finally {
      rendered.unmount();
    }
  });
});

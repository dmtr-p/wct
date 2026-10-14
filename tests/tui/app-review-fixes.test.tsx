import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  githubFixtures,
  renderApp,
  resetHarnessFixtures,
  selectedLine,
  sendKeys,
  setTallWorktrees,
  sgrPress,
  sgrWheel,
  tick,
  triggerRefresh,
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

  test("opening and cancelling a modal preserves a wheel-scrolled viewport", async () => {
    setTallWorktrees(repoPath, 40);

    const rendered = await renderApp(<App />, 14);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");

      // Scroll the selection off-screen so an unwanted reveal is observable.
      for (let i = 0; i < 15; i++) {
        await sendKeys(rendered.stdin, sgrWheel(1), 1);
      }
      await tick(5);
      const before = rendered.lines();
      expect(selectedLine(before)).toBeUndefined();
      const visibleBefore = before.filter((l) => /feature\/\d+/.test(l));
      expect(visibleBefore.length).toBeGreaterThan(0);

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

  test("reopening the Open modal refreshes only open PRs", async () => {
    setTallWorktrees(repoPath, 2);
    const rendered = await renderApp(<App />);
    try {
      await tick(25);
      for (let i = 0; i < 2; i++) {
        await sendKeys(rendered.stdin, "o");
        await tick(15);
        expect(rendered.output()).toContain("Select mode");
        await sendKeys(rendered.stdin, "\x1b");
        await new Promise((resolve) => setTimeout(resolve, 60));
        await tick(5);
      }
      expect(
        githubFixtures.listRequests.map((request) => request.state),
      ).toEqual(["all", "open", "open"]);
    } finally {
      rendered.unmount();
    }
  });

  test("a modal over a tree taller than the terminal renders intact (no garble)", async () => {
    setTallWorktrees(repoPath, 40);

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
      expect(frame.length).toBeLessThanOrEqual(14);
      expect(frame[0]?.startsWith("wct")).toBe(true);
      expect(frame[0]).toContain("[+Add]");
      const topBorder = frame.findIndex((l) => l.includes("Select mode"));
      const bottomBorder = frame.findIndex((l) => l.includes("╰"));
      expect(topBorder).toBeGreaterThan(-1);
      expect(frame[topBorder]).toContain("╭");
      expect(bottomBorder).toBeGreaterThan(topBorder);
    } finally {
      rendered.unmount();
    }
  });

  test("anchors close confirmation below the branch and scrolls it into view", async () => {
    setTallWorktrees(repoPath, 20);

    const rendered = await renderApp(<App />, 10);
    try {
      await tick(20);

      for (let i = 0; i < 17; i++) {
        await sendKeys(rendered.stdin, "\x1b[B", 1);
      }
      expect(selectedLine(rendered.lines())).toContain("feature/15");

      await sendKeys(rendered.stdin, "c");
      const frame = rendered.lines();
      const branchRow = frame.findIndex((line) => line.includes("feature/15"));
      const modalRow = frame.findIndex((line) =>
        line.includes("Close Worktree"),
      );

      expect(branchRow).toBeGreaterThan(-1);
      expect(modalRow).toBe(branchRow + 1);
      expect(frame.some((line) => line.includes("enter:confirm"))).toBe(true);

      const backgroundBranchRow = frame.findIndex(
        (line) => /feature\/\d+/.test(line) && !line.includes("feature/15"),
      );
      expect(backgroundBranchRow).toBeGreaterThan(-1);
      await sendKeys(rendered.stdin, sgrPress(3, backgroundBranchRow + 1));
      await sendKeys(rendered.stdin, "q\x1b[B");
      expect(selectedLine(rendered.lines())).toContain("feature/15");
      expect(
        rendered.lines().some((line) => line.includes("Close Worktree")),
      ).toBe(true);

      await sendKeys(rendered.stdin, "\x1b");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(
        rendered.lines().some((line) => line.includes("Close Worktree")),
      ).toBe(false);
    } finally {
      rendered.unmount();
    }
  });

  test("restores a selected detail row to the viewport after cancellation", async () => {
    setTallWorktrees(repoPath, 20);
    githubFixtures.prsByRepoPath.set(repoPath, [
      {
        number: 42,
        title: "Selected detail",
        state: "OPEN",
        headRefName: "feature/15",
        rollupState: "success",
      },
    ]);

    const rendered = await renderApp(<App />, 8);
    try {
      await tick(20);
      await sendKeys(rendered.stdin, "r");
      for (let i = 0; i < 17; i++) {
        await sendKeys(rendered.stdin, "\x1b[B", 1);
      }
      await sendKeys(rendered.stdin, "\x1b[C");
      await sendKeys(rendered.stdin, "\x1b[B");
      expect(selectedLine(rendered.lines())).toContain("#42");

      await sendKeys(rendered.stdin, "c");
      expect(
        rendered.lines().some((line) => line.includes("Close Worktree")),
      ).toBe(true);
      expect(selectedLine(rendered.lines())).toBeUndefined();

      await sendKeys(rendered.stdin, "\x1b");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(selectedLine(rendered.lines())).toContain("#42");
    } finally {
      rendered.unmount();
    }
  });

  test("cancels confirmation when a refresh removes its anchor", async () => {
    setTallWorktrees(repoPath, 5);

    const rendered = await renderApp(<App />, 12);
    try {
      await tick(20);
      for (let i = 0; i < 4; i++) {
        await sendKeys(rendered.stdin, "\x1b[B", 1);
      }
      expect(selectedLine(rendered.lines())).toContain("feature/2");
      await sendKeys(rendered.stdin, "c");
      expect(
        rendered.lines().some((line) => line.includes("Close Worktree")),
      ).toBe(true);

      worktreeFixtures.byRepoPath.set(
        repoPath,
        (worktreeFixtures.byRepoPath.get(repoPath) ?? []).filter(
          (worktree) => worktree.branch !== "feature/2",
        ),
      );
      await triggerRefresh();
      await tick(10);

      expect(
        rendered.lines().some((line) => line.includes("Close Worktree")),
      ).toBe(false);
    } finally {
      rendered.unmount();
    }
  });

  test("the open mode footer advances with keyboard selection", async () => {
    setTallWorktrees(repoPath, 3);

    const rendered = await renderApp(<App />, 24);
    try {
      await tick(20);
      await sendKeys(rendered.stdin, "o");

      expect(rendered.output()).toContain("1 of 3");

      await sendKeys(rendered.stdin, "\x1b[B");

      expect(rendered.output()).toContain("2 of 3");
    } finally {
      rendered.unmount();
    }
  });

  test("Ctrl+C disables mouse reporting BEFORE raw mode is turned off, then exits", async () => {
    setTallWorktrees(repoPath, 3);

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
    // Disable reporting before raw mode ends so in-flight mouse bytes cannot echo.
    expect(disableIndex).toBeGreaterThan(-1);
    expect(rawModeOffIndex).toBeGreaterThan(-1);
    expect(disableIndex).toBeLessThan(rawModeOffIndex);
  });

  test("q quits while the shortcuts modal is open", async () => {
    setTallWorktrees(repoPath, 3);

    const rendered = await renderApp(<App />, 24);
    await tick(20);

    await sendKeys(rendered.stdin, "?");
    expect(rendered.output()).toContain("Shortcuts");
    expect(rendered.output()).toContain("quit");

    await sendKeys(rendered.stdin, "q");
    await rendered.instance.waitUntilExit();

    expect(
      rendered.events.some(
        (event) => event.kind === "write" && event.data.includes(MOUSE_DISABLE),
      ),
    ).toBe(true);
  });

  test("legacy X10 mouse bytes are swallowed instead of typed into the Search query", async () => {
    setTallWorktrees(repoPath, 5);

    const rendered = await renderApp(<App />, 20);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");

      await sendKeys(rendered.stdin, "/"); // enter Search
      // X10 press/release at col 5, row 12. Payloads must not enter Search.
      await sendKeys(rendered.stdin, "\x1b[M %,\x1b[M#%,");
      await sendKeys(rendered.stdin, "f");
      await tick(5);

      // The query must be exactly "f": still matching feature/* rows, with
      // the query line rendered as "/f" with its insertion marker.
      expect(rendered.lines().some((l) => /^\/f▎?$/.test(l.trim()))).toBe(true);
      expect(selectedLine(rendered.lines())).toBeDefined();
    } finally {
      rendered.unmount();
    }
  });

  test("X10 coordinates that form valid UTF-8 do not swallow the next key", async () => {
    setTallWorktrees(repoPath, 5);

    const rendered = await renderApp(<App />, 20);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");

      await sendKeys(rendered.stdin, "/"); // enter Search
      // Coordinates 163/137 encode as C3 A9 (é). The adapter must count three
      // raw payload bytes, even though UTF-8 decoding would produce two chars.
      await sendKeys(rendered.stdin, "\x1b[M é\x1b[M#é");
      await sendKeys(rendered.stdin, "f");
      await tick(5);

      // The "f" typed after the click must reach the query,
      // and no payload characters may leak in.
      expect(rendered.lines().some((l) => /^\/f▎?$/.test(l.trim()))).toBe(true);
      expect(selectedLine(rendered.lines())).toBeDefined();
    } finally {
      rendered.unmount();
    }
  });

  test("X10 coordinates containing invalid UTF-8 never enter the query", async () => {
    setTallWorktrees(repoPath, 5);

    const rendered = await renderApp(<App />, 20);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");

      await sendKeys(rendered.stdin, "/"); // enter Search
      // Col 100 encodes as the invalid UTF-8 byte 0x84. Write raw bytes:
      // a string would re-encode the value and miss this regression.
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

      expect(rendered.lines().some((l) => /^\/f▎?$/.test(l.trim()))).toBe(true);
      expect(selectedLine(rendered.lines())).toBeDefined();
    } finally {
      rendered.unmount();
    }
  });

  test("a multi-line bracketed paste into Search stays on one query row", async () => {
    setTallWorktrees(repoPath, 5);

    const rendered = await renderApp(<App />, 20);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");

      await sendKeys(rendered.stdin, "/"); // enter Search
      // Ink's paste channel delivers the text as one edit. Search remains
      // one row even when the clipboard contains a newline.
      await sendKeys(rendered.stdin, "\x1b[200~feat\nure\x1b[201~");
      await tick(5);

      const lines = rendered.lines();
      // The newline is collapsed to a space on a single query row...
      expect(lines.some((l) => /^\/feat ure▎?$/.test(l.trim()))).toBe(true);
      // ...and no second line carries the paste's tail.
      expect(lines.some((l) => l.trim() === "ure")).toBe(false);
    } finally {
      rendered.unmount();
    }
  });

  test("editing Search in the middle updates matches while cursor movement keeps selection", async () => {
    setTallWorktrees(repoPath, 5);

    const rendered = await renderApp(<App />, 20);
    try {
      await tick(20);
      await sendKeys(rendered.stdin, "/");
      await sendKeys(rendered.stdin, "ft");
      expect(selectedLine(rendered.lines())).toBeUndefined();

      await sendKeys(rendered.stdin, "\x1b[D");
      await sendKeys(rendered.stdin, "ea");
      expect(rendered.lines().some((line) => line.trim() === "/feat")).toBe(
        true,
      );
      const selection = selectedLine(rendered.lines());
      expect(selection).toBeDefined();

      await sendKeys(rendered.stdin, "\x1b[D");
      await sendKeys(rendered.stdin, "\x1b[C");
      expect(rendered.lines().some((line) => line.trim() === "/feat")).toBe(
        true,
      );
      expect(selectedLine(rendered.lines())).toBe(selection);
    } finally {
      rendered.unmount();
    }
  });

  test("horizontal wheel events (cb 66/67) do not scroll the viewport", async () => {
    setTallWorktrees(repoPath, 40);

    const rendered = await renderApp(<App />, 14);
    try {
      await tick(20);
      expect(rendered.output()).toContain("main");
      const before = rendered.lines();

      // A horizontal trackpad swipe burst: wheel-left and wheel-right ticks.
      await sendKeys(rendered.stdin, "\x1b[<66;1;1M\x1b[<67;1;1M\x1b[<66;1;1M");
      await tick(5);

      expect(rendered.lines()).toEqual(before);
    } finally {
      rendered.unmount();
    }
  });
});

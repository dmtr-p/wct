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
//    swallowed by the guard instead of typing junk into the Search query.
// 5. Horizontal wheel events (SGR cb 66/67) do not scroll the viewport.
//
// Mocking strategy is identical to tests/tui/app-mouse-wiring.test.tsx.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Worktree } from "../../src/services/worktree-service";

const runtimeMock = vi.hoisted(() => ({
  runPromise: vi.fn((effect: unknown) => Promise.resolve(effect)),
  runSync: vi.fn((effect: unknown) => effect),
}));

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: runtimeMock,
  runTuiSilentPromise: (effect: unknown) => runtimeMock.runPromise(effect),
}));

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

vi.mock("../../src/services/github-service", () => ({
  GitHubService: {
    use: (selector: (svc: unknown) => unknown) =>
      selector({
        listPrs: () => Promise.resolve([]),
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
const { MOUSE_DISABLE } = await import("../../src/tui/hooks/useMouse");

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
  ref: () => NodeJS.ReadStream;
  unref: () => NodeJS.ReadStream;
};

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

async function renderApp(
  node: React.ReactElement,
  termRows = 32,
  termCols = 100,
) {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = termCols;
  stdout.rows = termRows;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = true;

  // Ordered event log shared by stdout writes and raw-mode flips, so tests
  // can assert real orderings (e.g. MOUSE_DISABLE before setRawMode(false)).
  // stdout.write is patched (not the 'data' event) because write is
  // synchronous with the caller while 'data' emission may be deferred.
  const events: Array<
    { kind: "write"; data: string } | { kind: "rawmode"; mode: boolean }
  > = [];
  // Forward EVERY argument: Ink resolves waitUntilExit via an empty write's
  // completion callback, so dropping the callback would hang the exit path.
  const originalWrite = stdout.write.bind(stdout) as (
    ...args: unknown[]
  ) => boolean;
  stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    events.push({
      kind: "write",
      data:
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    });
    return originalWrite(chunk, ...rest);
  }) as typeof stdout.write;
  stdin.setRawMode = (mode: boolean) => {
    events.push({ kind: "rawmode", mode });
    return stdin;
  };
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

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
    stdout,
    events,
    instance,
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

function sgrWheel(dir: 1 | -1): string {
  const cb = dir === -1 ? 64 : 65;
  return `\x1b[<${cb};1;1M`;
}

/** The single rendered line containing the ❯ selection cursor, or undefined. */
function selectedLine(lines: string[]): string | undefined {
  return lines.find((l) => l.includes("❯"));
}

describe("App.tsx review fixes (real App)", () => {
  let homeDir: string;
  let repoPath: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "wct-app-review-home-"));
    repoPath = mkdtempSync(join(tmpdir(), "wct-app-review-repo-"));
    mkdirSync(join(homeDir, ".wct"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    registryItems.items = [];
    worktreeFixtures.byRepoPath.clear();
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

  function setTallWorktrees(n: number) {
    worktreeFixtures.byRepoPath.set(repoPath, [
      worktree("main"),
      ...Array.from({ length: n }, (_, i) => worktree(`feature/${i}`)),
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

// Shared mocking strategy + Ink render harness for the suites that render the
// REAL exported `App` from `src/tui/App.tsx` through Ink's actual input
// pipeline (tests/tui/app-mouse-wiring.test.tsx and
// tests/tui/app-review-fixes.test.tsx). Centralising the service mocks here
// keeps the mocked service shapes in sync between those suites.
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
// config discovery is wrapped in a try/catch with a safe fallback in the
// real code, so passing it through unresolved is harmless.
//
// The `vi.mock` calls below execute when a test file imports this module —
// BEFORE that file's `await import("../../src/tui/App")` — so every mock is
// registered before any mocked service module is first loaded. The fixture
// objects are wrapped in `vi.hoisted` so the factories may reference them
// regardless of whether Vitest's hoisting transform rewrites this file.
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type React from "react";
import { vi } from "vitest";
import type { Worktree } from "../../src/services/worktree-service";
import { HEADER_OFFSET } from "../../src/tui/input/mouse";

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

// Ink disables ANSI colors for this PassThrough-based harness, so the selected
// background cannot be observed in serialized frames. Replace one fill space
// with a width-neutral private-use marker in this test worker only.
vi.mock("../../src/tui/components/tree-row", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/tui/components/tree-row")
  >("../../src/tui/components/tree-row");
  return {
    ...actual,
    selectedRowFill: (
      isSelected: boolean,
      maxWidth: number,
      content: string,
    ) => {
      const fill = actual.selectedRowFill(isSelected, maxWidth, content);
      return fill ? `${fill.slice(0, -1)}\uE000` : fill;
    },
  };
});

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

export { githubFixtures, registryItems, runtimeMock, worktreeFixtures };

/** Reset every controllable fixture and runtime spy; call from `beforeEach`. */
export function resetHarnessFixtures(): void {
  registryItems.items = [];
  worktreeFixtures.byRepoPath.clear();
  githubFixtures.prsByRepoPath.clear();
  runtimeMock.runPromise.mockClear();
  runtimeMock.runSync.mockClear();
}

export type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
export type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
  ref: () => NodeJS.ReadStream;
  unref: () => NodeJS.ReadStream;
};

export function makeWorktree(repoPath: string, branch: string): Worktree {
  return {
    path: join(repoPath, branch.replaceAll("/", "-")),
    branch,
    commit: "abc123",
    isBare: false,
  };
}

/**
 * Register a single repo ("repo-1" / project "alpha") whose tree is tall
 * enough to scroll: `main` plus `n` `feature/<i>` worktrees. Configures BOTH
 * the worktree and registry fixtures so callers can't drift apart on which
 * halves they set up.
 */
export function setTallWorktrees(repoPath: string, n: number): void {
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

export function stripAnsi(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (char === "\x1b" && value.charAt(i + 1) === "[") {
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

export async function tick(count = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function renderApp(
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
    // The last full frame Ink wrote, split into lines, ANSI stripped.
    lines: () => stripAnsi(chunks[chunks.length - 1] ?? "").split("\n"),
    output: () => stripAnsi(chunks.join("\n")),
    unmount() {
      instance.unmount();
    },
  };
}

export async function sendKeys(
  stdin: NodeJS.ReadStream,
  sequence: string,
  ticks = 5,
): Promise<void> {
  stdin.write(sequence);
  await tick(ticks);
}

export function sgrPress(col: number, row: number): string {
  return `\x1b[<0;${col};${row}M`;
}

export function sgrRelease(col: number, row: number): string {
  return `\x1b[<0;${col};${row}m`;
}

export function sgrWheel(dir: 1 | -1): string {
  // 64 = wheel up (dir -1), 65 = wheel down (dir 1)
  const cb = dir === -1 ? 64 : 65;
  return `\x1b[<${cb};1;1M`;
}

// HEADER_OFFSET (== App.tsx's TOP_CHROME_ROWS) is imported from the
// production module so the mapping stays aligned if the chrome layout changes.
export { HEADER_OFFSET };

export function sgrRowFor(viewportRow: number): number {
  return viewportRow + 1 + HEADER_OFFSET;
}

/** The selected row, identified by the width-neutral test marker above. */
export function selectedLine(lines: string[]): string | undefined {
  return lines.find((line) => line.includes("\uE000"));
}

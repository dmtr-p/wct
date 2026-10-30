// Import this harness before dynamically importing App so service mocks are
// registered first; their fixtures must use vi.hoisted. The promise runner
// evaluates Effects with fixture services and passes through plain mock results.
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Effect } from "effect";
import type React from "react";
import { vi } from "vitest";
import type { WctError } from "../../src/errors";
import type { PrFacts } from "../../src/services/pr-model";
import type {
  WorkspacePhase,
  WorkspaceReporter,
} from "../../src/services/workspace-service";
import type { Worktree } from "../../src/services/worktree-service";
import { HEADER_OFFSET } from "../../src/tui/input/mouse";
import { createTerminalInput } from "../../src/tui/input/terminal-input";

const serviceFixtures = vi.hoisted(() => ({
  github: null as
    import("../../src/services/github-service").GitHubService | null,
  cache: null as
    import("../../src/services/pr-cache-service").PrCacheServiceApi | null,
}));

const runtimeMock = vi.hoisted(() => ({
  runPromise: vi.fn((effect: Effect.Effect<unknown, WctError>) =>
    Promise.resolve(effect),
  ),
  runSync: vi.fn((effect: unknown) => effect),
}));

const refreshHarness = vi.hoisted(() => ({
  callback: null as (() => void | Promise<void>) | null,
}));

vi.mock("../../src/tui/runtime", async () => {
  const { Effect } = await vi.importActual<typeof import("effect")>("effect");
  const { BunServices } = await import("@effect/platform-bun");
  const { GitHubService } = await import("../../src/services/github-service");
  const { PrCacheService } =
    await import("../../src/services/pr-cache-service");
  const { PrRefreshService, makePrRefreshService } =
    await import("../../src/services/pr-refresh-service");
  const { RegistryService, liveRegistryService } =
    await import("../../src/services/registry-service");
  const { WorktreeService, liveWorktreeService, makeWorktreeService } =
    await import("../../src/services/worktree-service");
  const { TmuxService } = await import("../../src/services/tmux");
  const { noopTmuxService } = await import("../helpers/services");
  const { LocalObservationService, makeLocalObservationService } =
    await import("../../src/services/local-observation-service");
  const tmux = {
    ...noopTmuxService,
    listClients: Effect.sync(() => tmuxFixtures.clients),
    listSessions: Effect.sync(() => tmuxFixtures.sessions),
    switchClientToPane: (clientTty: string, target: string) =>
      Effect.sync(() => {
        tmuxFixtures.switchCalls.push({ clientTty, target });
        tmuxFixtures.onSwitch?.(clientTty, target);
      }),
  };
  const worktree = await Effect.runPromise(
    makeWorktreeService({
      ...liveWorktreeService,
      listWorktrees: (path?: string) =>
        Effect.sync(() => worktreeFixtures.byRepoPath.get(path ?? "") ?? []),
      getDefaultBranch: () => Effect.succeed("main"),
      getChangedFileCount: () => Effect.succeed(0),
      getAheadBehind: () => Effect.succeed({ ahead: 0, behind: 0 }),
    }).pipe(Effect.provide(BunServices.layer)),
  );
  const observation = await Effect.runPromise(
    makeLocalObservationService.pipe(
      Effect.provideService(RegistryService, {
        ...liveRegistryService,
        listRepos: Effect.sync(() =>
          registryItems.items.map((item) => ({ ...item, created_at: 0 })),
        ),
      }),
      Effect.provideService(WorktreeService, worktree),
      Effect.provideService(TmuxService, tmux),
      Effect.provide(BunServices.layer),
    ),
  );
  const provide = <A, E>(effect: Effect.Effect<A, E>) => {
    if (!serviceFixtures.github || !serviceFixtures.cache)
      throw new Error("Missing harness service fixtures");
    return effect.pipe(
      Effect.provideService(LocalObservationService, observation),
      Effect.provideService(TmuxService, tmux),
      Effect.provideService(WorktreeService, worktree),
      Effect.provideServiceEffect(PrRefreshService, makePrRefreshService),
      Effect.provideService(GitHubService, serviceFixtures.github),
      Effect.provideService(PrCacheService, serviceFixtures.cache),
      Effect.provide(BunServices.layer),
    );
  };
  const runPromise = async (
    effect: Effect.Effect<unknown, WctError>,
    options?: { signal?: AbortSignal },
  ) => {
    const result = await runtimeMock.runPromise(effect);
    return Effect.isEffect(result)
      ? Effect.runPromise(provide(result), options)
      : result;
  };
  return {
    tuiRuntime: {
      runPromise,
      runFork: (
        effect: Effect.Effect<unknown, WctError>,
        options?: Effect.RunOptions,
      ) => Effect.runFork(provide(effect), options),
    },
    runTuiSilentPromise: runPromise,
  };
});

vi.mock("../../src/tui/hooks/useRefresh", () => ({
  useRefresh: (callback: () => void | Promise<void>) => {
    refreshHarness.callback = callback;
  },
}));

// Ink disables ANSI colors for this PassThrough-based harness, so the selected
// background can't be observed in serialized frames. Replace one fill space
// with a width-neutral private-use marker instead.
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

const registryItems = vi.hoisted(() => ({
  items: [] as Array<{ id: string; repo_path: string; project: string }>,
}));

const worktreeFixtures = vi.hoisted(() => ({
  byRepoPath: new Map<string, Worktree[]>(),
}));

const tmuxFixtures = vi.hoisted(() => ({
  clients: [] as Array<{ tty: string; session: string }>,
  sessions: null as Array<{
    name: string;
    attached: boolean;
    windows: number;
  }> | null,
  switchCalls: [] as Array<{ clientTty: string; target: string }>,
  onSwitch: null as ((clientTty: string, target: string) => void) | null,
}));

// Drive "r" to await Navigate mode's PR refresh deterministically.
const githubFixtures = vi.hoisted(() => ({
  listRequests: [] as Array<{ repoPath: string; state: "all" | "updated" }>,
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

vi.mock("../../src/services/github-service", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/services/github-service")
  >("../../src/services/github-service");
  serviceFixtures.github = {
    isGhInstalled: Effect.succeed(true),
    resolvePr: () => Effect.die("unused"),
    addForkRemote: () => Effect.void,
    fetchBranch: () => Effect.void,
    findRemoteForRepo: () => Effect.succeed(null),
    resolveBaseRepo: () => Effect.succeed("test/repo"),
    getRawPrs: (repoPath: string, _base: string, numbers: readonly number[]) =>
      Effect.succeed(
        numbers.map((number) => {
          const pr = githubFixtures.prsByRepoPath
            .get(repoPath)
            ?.find((pr) => pr.number === number);
          return {
            number,
            error: pr ? null : "PR unavailable",
            raw: pr
              ? {
                  ...pr,
                  id: `PR-${pr.number}`,
                  headRepository: { nameWithOwner: "test/repo" },
                }
              : null,
          };
        }),
      ),
    listRawPrs: (repoPath: string, state: "all" | "updated") => {
      githubFixtures.listRequests.push({ repoPath, state });
      return Effect.succeed(
        (githubFixtures.prsByRepoPath.get(repoPath) ?? []).map((pr) => ({
          ...pr,
          id: `PR-${pr.number}`,
          headRepositoryOwner: { login: "test" },
          headRepository: { name: "repo" },
          headRefOid: `oid-${pr.number}`,
          baseRefName: "main",
          updatedAt: new Date().toISOString(),
          isDraft: false,
          statusCheckRollup:
            pr.rollupState === null
              ? []
              : [
                  {
                    name: "test",
                    conclusion: pr.rollupState.toUpperCase(),
                  },
                ],
        })),
      );
    },
  };
  return actual;
});

vi.mock("../../src/services/pr-discovery", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/services/pr-discovery")
  >("../../src/services/pr-discovery");
  return {
    ...actual,
    resolvePushDestination: (_cwd: string, branch: string) =>
      Effect.succeed({ repository: "test/repo", branch }),
  };
});

vi.mock("../../src/services/pr-details", () => ({
  fetchPrDetails: (_cwd: string, _repo: string, prs: PrFacts[]) =>
    Effect.succeed(
      prs.map((pr) => ({
        ...pr,
        checksComplete: true,
        isMergeQueueEnabled: false,
        isQueued: false,
      })),
    ),
}));

// Defer lifecycle completion until the test settles it so intermediate progress
// rows remain observable. Recorded options expose the App's reporter.
interface WorkspaceCallShape {
  operation: "open" | "up" | "down" | "close";
  options: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  promise: Promise<unknown>;
}

const workspaceHarness = vi.hoisted(() => {
  const calls: WorkspaceCallShape[] = [];
  const defer =
    (operation: "open" | "up" | "down" | "close") =>
    (options: Record<string, unknown> = {}) => {
      let resolve: (result: unknown) => void = () => undefined;
      let reject: (error: unknown) => void = () => undefined;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Suppress unhandled-rejection reporting for a call a test never settles.
      promise.catch(() => undefined);
      calls.push({ operation, options, resolve, reject, promise });
      return promise;
    };
  return {
    calls,
    service: {
      open: defer("open"),
      up: defer("up"),
      down: defer("down"),
      close: defer("close"),
    },
  };
});

vi.mock("../../src/services/workspace-service", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/services/workspace-service")
  >("../../src/services/workspace-service");
  const { Effect } = await vi.importActual<typeof import("effect")>("effect");
  const { toWctError } =
    await vi.importActual<typeof import("../../src/errors")>(
      "../../src/errors",
    );
  const wrap =
    (operation: WorkspaceCallShape["operation"]) =>
    (options: Record<string, unknown>) =>
      Effect.tryPromise({
        try: () => workspaceHarness.service[operation](options),
        catch: (error) => toWctError(error),
      });
  return {
    ...actual,
    WorkspaceService: {
      use: (selector: (svc: unknown) => unknown) =>
        selector({
          open: wrap("open"),
          up: wrap("up"),
          down: wrap("down"),
          close: wrap("close"),
        }),
    },
  };
});

vi.mock("../../src/services/pr-cache-service", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/services/pr-cache-service")
  >("../../src/services/pr-cache-service");
  serviceFixtures.cache = {
    ...actual.livePrCacheService,
    getHydration: () => Effect.succeed({ workspaces: [], openPrs: null }),
    getDiscovery: () => Effect.succeed(null),
    setDiscovery: () => Effect.succeed(true),
    getWorkspace: () => Effect.succeed(null),
    getWorkspaceInputs: (_path: string, branches: readonly string[]) =>
      Effect.succeed(
        branches.map((branch) => ({
          branch,
          explicit: null,
          cached: null,
        })),
      ),
    getOpenPrs: () => Effect.succeed(null),
    setWorkspace: () => Effect.void,
    setOpenPrs: () => Effect.void,
    pruneWorkspaces: () => Effect.void,
    setWorkspaceError: () => Effect.void,
  };
  return actual;
});

export {
  githubFixtures,
  registryItems,
  runtimeMock,
  tmuxFixtures,
  worktreeFixtures,
};

/** Lifecycle calls the App has made, oldest first. */
export function workspaceCalls(
  operation?: WorkspaceCallShape["operation"],
): WorkspaceCallShape[] {
  const calls = workspaceHarness.calls;
  return operation
    ? calls.filter((call) => call.operation === operation)
    : calls;
}

export function lastWorkspaceCall(
  operation?: WorkspaceCallShape["operation"],
): WorkspaceCallShape {
  const calls = workspaceCalls(operation);
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error(
      `no ${operation ?? "workspace"} call recorded by the harness`,
    );
  }
  return call;
}

export function emitWorkspacePhase(
  call: WorkspaceCallShape,
  phase: WorkspacePhase,
): void {
  const reporter = call.options.reporter as WorkspaceReporter | undefined;
  if (!reporter) {
    throw new Error(`${call.operation} was called without a reporter`);
  }
  Effect.runSync(
    reporter.event({
      operation: call.operation,
      _tag: "PhaseStarted",
      phase,
    }),
  );
}

export function resetHarnessFixtures(): void {
  registryItems.items = [];
  worktreeFixtures.byRepoPath.clear();
  githubFixtures.prsByRepoPath.clear();
  githubFixtures.listRequests.length = 0;
  tmuxFixtures.clients = [];
  tmuxFixtures.sessions = null;
  tmuxFixtures.switchCalls.length = 0;
  tmuxFixtures.onSwitch = null;
  workspaceHarness.calls.length = 0;
  runtimeMock.runPromise.mockClear();
  runtimeMock.runSync.mockClear();
  refreshHarness.callback = null;
}

export async function triggerRefresh(): Promise<void> {
  await refreshHarness.callback?.();
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
  renderOptions: { debug?: boolean; maxFps?: number } = {},
) {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = termCols;
  stdout.rows = termRows;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = true;

  // Ordered event log shared by stdout writes and raw-mode flips, so tests
  // can assert real orderings (e.g. MOUSE_DISABLE before setRawMode(false)).
  // write is patched rather than the 'data' event because write is
  // synchronous with the caller while 'data' emission may be deferred.
  const events: Array<
    { kind: "write"; data: string } | { kind: "rawmode"; mode: boolean }
  > = [];
  // Forward every argument: Ink resolves waitUntilExit via an empty write's
  // completion callback, so dropping it would hang the exit path.
  const originalWrite = stdout.write.bind(stdout) as (
    ...args: unknown[]
  ) => boolean;
  stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    events.push({
      kind: "write",
      data:
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    });
    return originalWrite(chunk, ...rest);
  };
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
  const input = createTerminalInput(stdin);
  const instance = render(node, {
    stdout,
    stdin: input.stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
    ...(renderOptions.debug === false ? { interactive: true } : {}),
    ...renderOptions,
  });

  return {
    stdin,
    stdout,
    events,
    instance,
    // The last full frame Ink wrote, split into lines, ANSI stripped.
    lines: () => {
      // Interactive Ink also writes cursor/synchronization controls separately
      // from the full frame. Those writes carry no visible content.
      const frame =
        renderOptions.debug === false
          ? chunks
              .toReversed()
              .map(stripAnsi)
              .find((chunk) => chunk.trim().length > 0)
          : stripAnsi(chunks[chunks.length - 1] ?? "");
      return (frame ?? "").split("\n");
    },
    output: () => stripAnsi(chunks.join("\n")),
    unmount() {
      instance.unmount();
      input.dispose();
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

// "o" opens the mode selector, Enter picks New Branch (whose branch field has
// initial focus), then the branch name and submit.
export async function openBranchFromModal(
  stdin: NodeJS.ReadStream,
  branch: string,
): Promise<void> {
  await sendKeys(stdin, "o");
  await sendKeys(stdin, "\r");
  await sendKeys(stdin, branch);
  await sendKeys(stdin, "\x1b[13;5u");
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

// Re-exported from the production module so it stays aligned with App.tsx's
// chrome layout.
export { HEADER_OFFSET };

export function sgrRowFor(viewportRow: number): number {
  return viewportRow + 1 + HEADER_OFFSET;
}

/** The selected row, identified by the width-neutral test marker above. */
export function selectedLine(lines: string[]): string | undefined {
  return lines.find((line) => line.includes("\uE000"));
}

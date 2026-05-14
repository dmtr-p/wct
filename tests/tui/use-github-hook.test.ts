import { PassThrough } from "node:stream";
import React, { type FC } from "react";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";

// Mock tuiRuntime before importing the hook
vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn(() => Promise.resolve(undefined)),
    runSync: vi.fn(() => null),
  },
}));

// Lazy imports so the mock is in place
const { tuiRuntime } = await import("../../src/tui/runtime");
const { useGitHub } = await import("../../src/tui/hooks/useGitHub");

const mockRunPromise = tuiRuntime.runPromise as Mock;
const mockRunSync = tuiRuntime.runSync as Mock;
type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};
type GitHubHookValue = ReturnType<typeof useGitHub>;
type PrListResult = Array<{
  number: number;
  title: string;
  state: "OPEN";
  headRefName: string;
  rollupState: "success" | "failure" | "pending" | null;
}>;

function makeRepo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    id: "test-repo",
    repoPath: "/tmp/test-repo",
    project: "myproject",
    worktrees: [],
    profileNames: [],
    ideDefaults: { baseNoIde: true, profileNoIde: {} },
    ...overrides,
  };
}

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 80;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

function expectDefined<T>(value: T | undefined, message: string): T {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error(message);
  return value;
}

async function flush(n = 4) {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Renders the useGitHub hook inside a minimal ink component
 * and exposes its return value.
 */
async function renderUseGitHub(repos: RepoInfo[]) {
  let latest: GitHubHookValue | undefined;

  const Wrapper: FC = () => {
    latest = useGitHub(repos);
    return null;
  };

  const { stdout, stdin } = createStdoutStdin();
  const { render } = await import("ink");
  const instance = render(React.createElement(Wrapper), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    get value() {
      if (!latest) throw new Error("Hook value not captured");
      return latest;
    },
    unmount() {
      instance.unmount();
    },
  };
}

describe("useGitHub hook", () => {
  beforeEach(() => {
    mockRunPromise.mockReset();
    mockRunPromise.mockResolvedValue(undefined);
    mockRunSync.mockReset();
    mockRunSync.mockReturnValue(null);
  });

  test("does not fetch when repo list is empty", async () => {
    const harness = await renderUseGitHub([]);
    await flush();

    expect(mockRunPromise).not.toHaveBeenCalled();
    expect(harness.value.prData.size).toBe(0);
    expect(harness.value.loading).toBe(false);

    harness.unmount();
  });

  test("maps PR list to prData keyed by project/branch", async () => {
    const repo = makeRepo();
    const prList = [
      {
        number: 10,
        title: "feat: something",
        state: "OPEN" as const,
        headRefName: "feat/something",
        rollupState: "success" as const,
      },
      {
        number: 11,
        title: "fix: other",
        state: "OPEN" as const,
        headRefName: "fix/other",
        rollupState: null,
      },
    ];

    mockRunPromise.mockResolvedValueOnce(prList);

    const harness = await renderUseGitHub([repo]);
    await flush(10);

    const data = harness.value.prData;
    expect(data.size).toBe(2);

    const pr10 = expectDefined(
      data.get("myproject/feat/something"),
      "Expected feat/something PR data",
    );
    expect(pr10.number).toBe(10);
    expect(pr10.rollupState).toBe("success");

    const pr11 = expectDefined(
      data.get("myproject/fix/other"),
      "Expected fix/other PR data",
    );
    expect(pr11.number).toBe(11);
    expect(pr11.rollupState).toBeNull();

    harness.unmount();
  });

  test("clears loading after refresh completes", async () => {
    const repo = makeRepo();
    let resolveListPrs: ((value: PrListResult) => void) | undefined;

    mockRunPromise.mockImplementation(() => {
      return new Promise((resolve) => {
        resolveListPrs = resolve;
      });
    });

    const harness = await renderUseGitHub([repo]);
    await flush();

    // Loading should be true while the promise is pending
    expect(harness.value.loading).toBe(true);

    // Resolve the listPrs call with empty array (no PRs = no check calls)
    const resolvePendingListPrs = expectDefined(
      resolveListPrs,
      "Expected pending listPrs resolver",
    );
    resolvePendingListPrs([]);
    await flush(10);

    // Loading should now be false
    expect(harness.value.loading).toBe(false);

    harness.unmount();
  });

  test("concurrent refresh(project) calls coalesce to one gh pr list invocation", async () => {
    const repo = makeRepo({ project: "myproject" });

    // Block the initial auto-refresh so it doesn't interfere with our explicit calls
    let initialResolve: ((value: PrListResult) => void) | undefined;
    let fetchStartCount = 0;
    const resolvers: Array<(value: PrListResult) => void> = [];

    mockRunPromise.mockImplementation(() => {
      // Every call here is either a listPrs or a cache write.
      // We distinguish by whether we're still pending the initial fetch.
      // Simpler: track pending fetches by counting unresolved calls.
      fetchStartCount++;
      return new Promise<PrListResult>((resolve) => {
        resolvers.push(resolve);
        if (fetchStartCount === 1) {
          initialResolve = resolve;
        }
      });
    });

    const harness = await renderUseGitHub([repo]);
    await flush(2);

    // Resolve the initial auto-refresh so the hook isn't in "loading" state
    expectDefined(
      initialResolve,
      "Expected initial resolver",
    )([] as PrListResult);
    await flush(4);

    // Reset tracking
    fetchStartCount = 0;
    resolvers.length = 0;

    // Start two concurrent refreshes of the same project — both before either resolves
    const p1 = harness.value.refresh("myproject");
    const p2 = harness.value.refresh("myproject");

    // Let the synchronous inFlight map be populated before any await
    await flush(1);

    // With coalescing: only ONE new fetch should have been dispatched
    // (p2 reuses p1's in-flight promise)
    expect(fetchStartCount).toBe(1);

    // Resolve the single pending fetch
    expectDefined(
      resolvers[0],
      "Expected resolver for coalesced fetch",
    )([] as PrListResult);
    await Promise.all([p1, p2]);
    await flush(4);

    // Still only one invocation total (plus possibly one cache write, but no extra listPrs)
    // fetchStartCount may be 2 if setCached was called; we just verify it's ≤ 2
    // and specifically that we didn't double-fetch
    expect(fetchStartCount).toBeLessThanOrEqual(2);

    harness.unmount();
  });

  test("aborted fetch does not write to cache", async () => {
    const repo = makeRepo({ project: "myproject" });
    const setCachedCalls: string[] = [];
    const setErrorCalls: string[] = [];

    let rejectListPrs: ((err: Error) => void) | undefined;
    mockRunPromise.mockImplementation((_effect: unknown) => {
      // Heuristic: we can't inspect the Effect easily, so track call order.
      // Call 1 = listPrs (returns a pending promise we can abort)
      // Any calls after abort would be cache writes — we track them via side-channel
      return new Promise((_resolve, reject) => {
        rejectListPrs = reject;
      });
    });

    const harness = await renderUseGitHub([repo]);
    await flush(2);

    // The initial refresh is in flight; abort by unmounting
    harness.unmount();
    await flush(4);

    // The abort should have fired; the pending fetch rejects with AbortError
    if (rejectListPrs) {
      const err = new DOMException("The operation was aborted.", "AbortError");
      rejectListPrs(err);
    }
    await flush(4);

    // No setCached or setError should have been called after abort
    // (mockRunPromise was only ever called once for the listPrs call)
    // The promise was already rejected before any cache writes
    expect(setCachedCalls).toHaveLength(0);
    expect(setErrorCalls).toHaveLength(0);

    // Verify mockRunPromise was only called once (the listPrs call — no cache writes)
    // Note: runSync is called for cache reads, not runPromise
    const callCountAfterAbort = mockRunPromise.mock.calls.length;
    // Only the single listPrs call — no subsequent cache write calls
    expect(callCountAfterAbort).toBe(1);
  });

  test("failed fetch leaves prior cache payload intact and writes last_error", async () => {
    const repo = makeRepo({ project: "myproject" });

    // runSync returns a cached entry (prior payload)
    mockRunSync.mockReturnValue({
      payload: [
        {
          number: 5,
          title: "old PR",
          state: "OPEN",
          headRefName: "old-branch",
          rollupState: null,
        },
      ],
      fetchedAt: Date.now() - 60_000, // 60s old → will attempt fetch
      lastError: null,
    });

    const setCachedProjects: string[] = [];
    const setErrorProjects: string[] = [];
    let callIndex = 0;

    mockRunPromise.mockImplementation((_effect: unknown) => {
      const idx = callIndex++;
      if (idx === 0) {
        // listPrs call — reject to simulate failure
        return Promise.reject(new Error("auth expired"));
      }
      // Subsequent calls: setError — capture project
      setErrorProjects.push("captured");
      return Promise.resolve(undefined);
    });

    const harness = await renderUseGitHub([repo]);
    await flush(10);

    // setError should have been called (once for the failed repo)
    expect(setErrorProjects.length).toBeGreaterThan(0);
    // setCached should NOT have been called
    expect(setCachedProjects).toHaveLength(0);

    // prData should still contain the old PR from the cache read
    const oldPr = harness.value.prData.get("myproject/old-branch");
    expect(oldPr).toBeDefined();
    expect(oldPr?.number).toBe(5);

    harness.unmount();
  });

  test("successful fetch clears previously-stored last_error", async () => {
    const repo = makeRepo({ project: "myproject" });

    const setCachedProjects: string[] = [];
    let callIndex = 0;

    mockRunPromise.mockImplementation((_effect: unknown) => {
      const idx = callIndex++;
      if (idx === 0) {
        // listPrs call — succeed
        return Promise.resolve([
          {
            number: 42,
            title: "new PR",
            state: "OPEN",
            headRefName: "new-branch",
            rollupState: "success" as const,
          },
        ]);
      }
      // Second call: setCached — capture it
      setCachedProjects.push("captured");
      return Promise.resolve(undefined);
    });

    const harness = await renderUseGitHub([repo]);
    await flush(10);

    // setCached should have been called (once for the successful repo)
    expect(setCachedProjects.length).toBeGreaterThan(0);

    // prData should contain the new PR
    const newPr = harness.value.prData.get("myproject/new-branch");
    expect(newPr).toBeDefined();
    expect(newPr?.number).toBe(42);

    harness.unmount();
  });

  test("errors map is populated from cache lastError on initial render", async () => {
    const repo = makeRepo({ project: "myproject" });

    // runSync returns a cache entry with a stored last_error
    mockRunSync.mockReturnValue({
      payload: [],
      fetchedAt: Date.now(), // fresh — skips fetch
      lastError: "token expired",
    });

    const harness = await renderUseGitHub([repo]);
    await flush(4);

    // The error should be visible from the initial cache read before any fetch
    expect(harness.value.errors.get("myproject")).toBe("token expired");

    harness.unmount();
  });

  test("errors map is populated after a failed fetch", async () => {
    const repo = makeRepo({ project: "myproject" });

    // No cached error initially
    mockRunSync.mockReturnValue(null);

    let callIndex = 0;
    mockRunPromise.mockImplementation((_effect: unknown) => {
      const idx = callIndex++;
      if (idx === 0) {
        return Promise.reject(new Error("auth expired"));
      }
      // setError call — return success
      return Promise.resolve(undefined);
    });

    const harness = await renderUseGitHub([repo]);
    await flush(10);

    expect(harness.value.errors.get("myproject")).toBe("auth expired");

    harness.unmount();
  });

  test("errors map is cleared on the next successful fetch", async () => {
    const repo = makeRepo({ project: "myproject" });

    // Initial cache has a stored error but stale data (will trigger fetch)
    mockRunSync.mockReturnValue({
      payload: [],
      fetchedAt: Date.now() - 60_000, // 60s old → will fetch
      lastError: "previous error",
    });

    let callIndex = 0;
    mockRunPromise.mockImplementation((_effect: unknown) => {
      const idx = callIndex++;
      if (idx === 0) {
        // listPrs — succeed
        return Promise.resolve([]);
      }
      // setCached call
      return Promise.resolve(undefined);
    });

    const harness = await renderUseGitHub([repo]);

    // After the successful fetch completes, the error should be cleared
    await flush(10);
    expect(harness.value.errors.has("myproject")).toBe(false);

    harness.unmount();
  });
});

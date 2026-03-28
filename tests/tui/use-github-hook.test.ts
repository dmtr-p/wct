import { PassThrough } from "node:stream";
import React, { type FC } from "react";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";

// Mock tuiRuntime before importing the hook
vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn(),
  },
}));

// Lazy imports so the mock is in place
const { tuiRuntime } = await import("../../src/tui/runtime");
const { useGitHub } = await import("../../src/tui/hooks/useGitHub");

const mockRunPromise = tuiRuntime.runPromise as Mock;

function makeRepo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    id: "test-repo",
    repoPath: "/tmp/test-repo",
    project: "myproject",
    worktrees: [],
    profileNames: [],
    ...overrides,
  };
}

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 80;
  (stdout as any).rows = 24;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = false;
  (stdin as any).setRawMode = () => stdin;
  return { stdout, stdin };
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
  let latest: ReturnType<typeof useGitHub> | undefined;

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
  });

  test("does not fetch when repo list is empty", async () => {
    const harness = await renderUseGitHub([]);
    await flush();

    expect(mockRunPromise).not.toHaveBeenCalled();
    expect(harness.value.prData.size).toBe(0);
    expect(harness.value.loading).toBe(false);

    harness.unmount();
  });

  test("keeps PR entries when check fetch fails for one PR", async () => {
    const repo = makeRepo();
    const prList = [
      {
        number: 10,
        title: "feat: something",
        state: "OPEN" as const,
        headRefName: "feat/something",
      },
      {
        number: 11,
        title: "fix: other",
        state: "OPEN" as const,
        headRefName: "fix/other",
      },
    ];

    let callCount = 0;
    mockRunPromise.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: listPrs
        return Promise.resolve(prList);
      }
      if (callCount === 2) {
        // Second call: listPrChecks — succeeds
        return Promise.resolve([{ name: "build", state: "SUCCESS" }]);
      }
      // Third call: listPrChecks — fails
      return Promise.reject(new Error("checks unavailable"));
    });

    const harness = await renderUseGitHub([repo]);
    await flush(10);

    const data = harness.value.prData;
    expect(data.size).toBe(2);

    const pr10 = data.get("myproject/feat/something");
    expect(pr10).toBeDefined();
    expect(pr10!.number).toBe(10);
    expect(pr10!.checks).toEqual([{ name: "build", state: "SUCCESS" }]);

    const pr11 = data.get("myproject/fix/other");
    expect(pr11).toBeDefined();
    expect(pr11!.number).toBe(11);
    expect(pr11!.checks).toEqual([]);

    harness.unmount();
  });

  test("clears loading after refresh completes", async () => {
    const repo = makeRepo();
    let resolveListPrs: ((v: any) => void) | undefined;

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
    resolveListPrs!([]);
    await flush(10);

    // Loading should now be false
    expect(harness.value.loading).toBe(false);

    harness.unmount();
  });
});

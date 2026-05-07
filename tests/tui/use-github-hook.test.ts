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
});

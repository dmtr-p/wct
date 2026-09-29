import { PassThrough } from "node:stream";
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: { runPromise: vi.fn(), runSync: vi.fn(() => null) },
}));
const { tuiRuntime } = await import("../../src/tui/runtime");
const { useGitHub } = await import("../../src/tui/hooks/useGitHub");
const runPromise = vi.mocked(tuiRuntime.runPromise);
const runSync = vi.mocked(tuiRuntime.runSync);

function repo(path = "/tmp/repo"): RepoInfo {
  return {
    id: path,
    repoPath: path,
    project: "same-name",
    worktrees: [],
    profileNames: [],
  };
}

async function renderHook(repos: RepoInfo[]) {
  let value: ReturnType<typeof useGitHub> | undefined;
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 80;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean;
    setRawMode: (value: boolean) => NodeJS.ReadStream;
  };
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  const { render } = await import("ink");
  function Hook({ repos: currentRepos }: { repos: RepoInfo[] }) {
    value = useGitHub(currentRepos);
    return null;
  }
  const instance = render(React.createElement(Hook, { repos }), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    get value() {
      if (!value) throw new Error("Missing hook value");
      return value;
    },
    rerender: (nextRepos: RepoInfo[]) =>
      instance.rerender(React.createElement(Hook, { repos: nextRepos })),
    unmount: () => instance.unmount(),
  };
}

async function settle() {
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useGitHub", () => {
  beforeEach(() => {
    runPromise.mockReset();
    runSync.mockReset();
    runSync.mockReturnValue(null as never);
  });

  test("does not fetch an empty registry", async () => {
    const harness = await renderHook([]);
    await settle();
    expect(runPromise).not.toHaveBeenCalled();
    expect(harness.value.prData.size).toBe(0);
    harness.unmount();
  });

  test("keeps the Open-modal list separate from Workspace associations", async () => {
    const raw = {
      number: 42,
      title: "Open PR",
      state: "OPEN",
      headRefName: "feature",
    };
    let call = 0;
    runPromise.mockImplementation((() => {
      call++;
      return Promise.resolve(
        call === 1
          ? "base/repo"
          : call === 2
            ? []
            : call === 3
              ? [raw]
              : call === 4
                ? []
                : undefined,
      );
    }) as typeof tuiRuntime.runPromise);
    const harness = await renderHook([repo()]);
    await settle();
    expect(
      harness.value.openPrs.get("/tmp/repo")?.map((pr) => pr.number),
    ).toEqual([42]);
    expect(harness.value.prData.size).toBe(0);
    harness.unmount();
  });

  test("a fetch failure is scoped by repository path", async () => {
    runPromise.mockRejectedValue(new Error("offline"));
    const harness = await renderHook([repo("/tmp/a")]);
    await settle();
    expect(harness.value.errors.get("/tmp/a")).toContain("offline");
    expect(harness.value.errors.has("/tmp/b")).toBe(false);
    harness.unmount();
  });

  test("a repository change starts a fresh request after aborting the old one", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    let calls = 0;
    runPromise.mockImplementation(((_effect, options) => {
      calls++;
      if (calls === 1)
        return new Promise((_, reject) => {
          rejectFirst = reject;
          options?.signal?.addEventListener("abort", () =>
            rejectFirst(new Error("aborted")),
          );
        });
      return Promise.resolve(calls === 2 ? "base/repo" : []);
    }) as typeof tuiRuntime.runPromise);
    const initial = repo();
    const harness = await renderHook([initial]);
    await settle();
    expect(calls).toBe(1);
    harness.rerender([
      {
        ...initial,
        worktrees: [
          {
            branch: "main",
            path: initial.repoPath,
            isMainWorktree: true,
            changedFiles: 0,
            sync: null,
          },
        ],
      },
    ]);
    await settle();
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(harness.value.errors.has(initial.repoPath)).toBe(false);
    harness.unmount();
  });

  test("an explicit association refreshes after an in-flight request", async () => {
    let releaseFirst: (repository: string) => void = () => {};
    let calls = 0;
    runPromise.mockImplementation((() => {
      calls++;
      if (calls === 1)
        return new Promise<string>((resolve) => {
          releaseFirst = resolve;
        });
      if (calls === 3 || calls === 4 || calls === 8 || calls === 9)
        return Promise.resolve([]);
      return Promise.resolve(calls === 7 ? "base/repo" : undefined);
    }) as typeof tuiRuntime.runPromise);
    const harness = await renderHook([repo()]);
    await settle();
    expect(calls).toBe(1);
    const update = harness.value.setExplicit("/tmp/repo", "feature", {
      baseRepository: "base/repo",
      number: 42,
    } as Parameters<ReturnType<typeof useGitHub>["setExplicit"]>[2]);
    await settle();
    expect(calls).toBe(2);
    releaseFirst("base/repo");
    await update;
    expect(calls).toBe(11);
    harness.unmount();
  });

  test("a post-submission refresh waits for an older request", async () => {
    let releaseFirst: (repository: string) => void = () => {};
    let calls = 0;
    runPromise.mockImplementation((() => {
      calls++;
      if (calls === 1)
        return new Promise<string>((resolve) => {
          releaseFirst = resolve;
        });
      return Promise.resolve(calls === 6 ? "base/repo" : []);
    }) as typeof tuiRuntime.runPromise);
    const harness = await renderHook([repo()]);
    await settle();
    expect(calls).toBe(1);
    const fresh = harness.value.refreshAfterCurrent("/tmp/repo");
    await settle();
    expect(calls).toBe(1);
    releaseFirst("base/repo");
    await fresh;
    expect(calls).toBe(10);
    harness.unmount();
  });
});

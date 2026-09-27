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
  const instance = render(
    React.createElement(() => {
      value = useGitHub(repos);
      return null;
    }),
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );
  return {
    get value() {
      if (!value) throw new Error("Missing hook value");
      return value;
    },
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
});

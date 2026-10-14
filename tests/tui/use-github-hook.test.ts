import { PassThrough } from "node:stream";
import { Effect } from "effect";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { commandError } from "../../src/errors";
import { GitHubService } from "../../src/services/github-service";
import {
  livePrCacheService,
  PrCacheService,
  type PrCacheServiceApi,
  type ExplicitPrAssociation,
  type WorkspacePrEntry,
} from "../../src/services/pr-cache-service";
import type { PrFacts } from "../../src/services/pr-model";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: { runPromise: vi.fn(), runSync: vi.fn(() => null) },
}));
vi.mock("../../src/services/pr-discovery", async () => ({
  ...(await vi.importActual<typeof import("../../src/services/pr-discovery")>(
    "../../src/services/pr-discovery",
  )),
  resolvePushDestination: (_cwd: string, branch: string) =>
    Effect.succeed(
      branch === "unknown" ? null : { repository: "fork/repo", branch },
    ),
}));
vi.mock("../../src/services/pr-details", () => ({
  fetchPrDetails: (_cwd: string, _base: string, prs: PrFacts[]) =>
    Effect.sync(() =>
      prs.map((pr) => ({
        ...pr,
        checks: [],
        checksComplete: !detailError,
        lastError: detailError,
      })),
    ),
}));
const { tuiRuntime } = await import("../../src/tui/runtime");
const { useGitHub } = await import("../../src/tui/hooks/useGitHub");
const runPromise = vi.mocked(tuiRuntime.runPromise);

function rawPr(
  number: number,
  state = "OPEN",
  branch = "feature",
  head = "fork/repo",
) {
  return {
    number,
    state,
    title: `PR ${number}`,
    headRefName: branch,
    headRepository: { nameWithOwner: head },
    updatedAt: `2026-10-${String(number).padStart(2, "0")}`,
  };
}
let history: ReturnType<typeof rawPr>[];
let listError: string | null;
let detailError: string | null;
let getError: string | null;
let base: string;
let holdList: Promise<void> | null;
const list = vi.fn((_cwd: string, state: "all" | "open", _base: string) =>
  Effect.promise(async () => {
    if (holdList) await holdList;
  }).pipe(
    Effect.flatMap(() =>
      listError
        ? Effect.fail(commandError("pr_error", listError))
        : Effect.succeed(
            history.filter((pr) => state === "all" || pr.state === "OPEN"),
          ),
    ),
  ),
);
const get = vi.fn((_cwd: string, _base: string, number: number) =>
  Effect.suspend(() =>
    getError
      ? Effect.fail(commandError("pr_error", getError))
      : Effect.succeed(
          history.find((pr) => pr.number === number) ?? rawPr(number, "MERGED"),
        ),
  ),
);
const github = GitHubService.of({
  isGhInstalled: Effect.succeed(true),
  resolvePr: () =>
    Effect.succeed({
      branch: "feature",
      prNumber: 1,
      isCrossRepository: false,
    }),
  addForkRemote: () => Effect.void,
  fetchBranch: () => Effect.void,
  findRemoteForRepo: () => Effect.succeed(null),
  resolveBaseRepo: () => Effect.sync(() => base),
  listRawPrs: list,
  getRawPr: get,
});
const workspaceCache = new Map<string, WorkspacePrEntry>();
const explicitCache = new Map<string, ExplicitPrAssociation>();
const key = (path: string, branch: string) => `${path}\0${branch}`;
const cache = PrCacheService.of({
  ...livePrCacheService,
  getWorkspace: (path, branch) =>
    Effect.sync(() => workspaceCache.get(key(path, branch)) ?? null),
  setWorkspace: (path, branch, entry) =>
    Effect.sync(() => {
      workspaceCache.set(key(path, branch), entry);
    }),
  setWorkspaceError: (path, branch, message) =>
    Effect.sync(() => {
      const entry = workspaceCache.get(key(path, branch));
      if (entry)
        workspaceCache.set(key(path, branch), { ...entry, lastError: message });
    }),
  getExplicit: (path, branch) =>
    Effect.sync(() => explicitCache.get(key(path, branch)) ?? null),
  setExplicit: (path, branch, association) =>
    Effect.sync(() => {
      explicitCache.set(key(path, branch), association);
    }),
  clearExplicit: (path, branch) =>
    Effect.sync(() => {
      explicitCache.delete(key(path, branch));
    }),
  getOpenPrs: () => Effect.succeed(null),
  setOpenPrs: () => Effect.void,
  pruneWorkspaces: (path, branches) =>
    Effect.sync(() => {
      for (const identity of explicitCache.keys())
        if (
          identity.startsWith(`${path}\0`) &&
          !branches.includes(identity.slice(path.length + 1))
        )
          explicitCache.delete(identity);
    }),
});

function repo(path = "/tmp/repo", branches: string[] = []): RepoInfo {
  return {
    id: path,
    repoPath: path,
    project: "same-name",
    profileNames: [],
    worktrees: branches.map((branch) => ({
      branch,
      path: `${path}/${branch}`,
      isMainWorktree: false,
      changedFiles: 0,
      sync: null,
    })),
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
  for (let i = 0; i < 12; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
}
async function poll() {
  vi.advanceTimersByTime(120_000);
  await settle();
}

describe("useGitHub", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    history = [];
    listError = detailError = getError = null;
    base = "base/repo";
    holdList = null;
    workspaceCache.clear();
    explicitCache.clear();
    list.mockClear();
    get.mockClear();
    runPromise.mockReset();
    runPromise.mockImplementation((<A, E>(
      effect: Effect.Effect<A, E, GitHubService | PrCacheServiceApi>,
      options?: { signal?: AbortSignal },
    ) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(GitHubService, github),
          Effect.provideService(PrCacheService, cache),
        ),
        options,
      )) as typeof tuiRuntime.runPromise);
  });
  afterEach(() => vi.useRealTimers());

  test("does not fetch an empty registry", async () => {
    const harness = await renderHook([]);
    try {
      await settle();
      expect(runPromise).not.toHaveBeenCalled();
      expect(harness.value.prData.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("derives the modal list from one complete discovery then polls only open PRs", async () => {
    history = [rawPr(1), rawPr(2, "MERGED")];
    const harness = await renderHook([repo()]);
    try {
      await settle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all"]);
      expect(
        harness.value.openPrs.get("/tmp/repo")?.map((pr) => pr.number),
      ).toEqual([1]);
      expect(harness.value.prData.size).toBe(0);
      await poll();
      await poll();
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "open",
        "open",
      ]);
      expect(get).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });

  test("refreshes closed associations and known open PRs that disappear without fetching unrelated history", async () => {
    history = [
      rawPr(1, "OPEN"),
      rawPr(2, "MERGED"),
      rawPr(3, "CLOSED", "other"),
    ];
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await settle();
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
      ).toBe(1);
      history[0] = rawPr(1, "MERGED");
      await poll();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all", "open"]);
      expect(
        get.mock.calls.map((call) => call[2]).sort((a, b) => a - b),
      ).toEqual([1, 2]);
      expect(harness.value.prData.get(key("/tmp/repo", "feature"))?.state).toBe(
        "MERGED",
      );
      expect(harness.value.openPrs.get("/tmp/repo")).toEqual([]);
    } finally {
      harness.unmount();
    }
  });

  test("keeps fork identities and ambiguous candidates, including an unknown Push Destination", async () => {
    history = [
      rawPr(1),
      rawPr(2, "OPEN", "feature", "other/repo"),
      rawPr(3),
      rawPr(4, "CLOSED", "unknown", "other/repo"),
    ];
    const harness = await renderHook([
      repo("/tmp/repo", ["feature", "unknown"]),
    ]);
    try {
      await settle();
      await poll();
      const entry = harness.value.associations.get(key("/tmp/repo", "feature"));
      expect(entry?.pr).toBeNull();
      expect(entry?.uncertain).toBe(true);
      expect(
        entry?.candidates.map((pr) => pr.number).sort((a, b) => a - b),
      ).toEqual([1, 3]);
      const unknown = harness.value.associations.get(
        key("/tmp/repo", "unknown"),
      );
      expect(unknown?.pr).toBeNull();
      expect(unknown?.candidates.map((pr) => pr.number)).toEqual([4]);
      expect(get.mock.calls.map((call) => call[2])).toEqual([4]);
    } finally {
      harness.unmount();
    }
  });

  test("fetches an external Explicit PR Association once for shared Workspaces and retains it after closure", async () => {
    history = [rawPr(1), rawPr(2, "MERGED")];
    const association = { baseRepository: "external/repo", number: 8 };
    explicitCache.set(key("/tmp/repo", "feature"), association);
    explicitCache.set(key("/tmp/repo", "second"), association);
    const harness = await renderHook([
      repo("/tmp/repo", ["feature", "second"]),
    ]);
    try {
      await settle();
      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenLastCalledWith("/tmp/repo", "external/repo", 8);
      await poll();
      expect(get.mock.calls.filter((call) => call[2] === 8)).toHaveLength(2);
      const entry = harness.value.associations.get(key("/tmp/repo", "feature"));
      expect(entry?.pr).toMatchObject({
        number: 8,
        state: "MERGED",
        baseRepository: "external/repo",
      });
      expect(entry?.explicit).toBe(true);
      expect(entry?.newerOpenPr).toBe(1);
      await harness.value.clearExplicit("/tmp/repo", "feature");
      await settle();
      expect(
        harness.value.associations
          .get(key("/tmp/repo", "feature"))
          ?.candidates.map((pr) => pr.baseRepository),
      ).toEqual(["base/repo", "base/repo"]);
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
      ).toBe(1);
    } finally {
      harness.unmount();
    }
  });

  test("new Workspaces use cached complete history and manual refresh discovers older missing matches", async () => {
    history = [rawPr(1, "MERGED", "old")];
    const harness = await renderHook([repo()]);
    try {
      await settle();
      harness.rerender([repo("/tmp/repo", ["old", "feature"])]);
      await settle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all", "open"]);
      expect(harness.value.prData.get(key("/tmp/repo", "old"))?.number).toBe(1);
      history.push(rawPr(2, "CLOSED"));
      await poll();
      expect(harness.value.prData.has(key("/tmp/repo", "feature"))).toBe(false);
      await harness.value.refresh("/tmp/repo");
      await settle();
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "open",
        "open",
        "all",
      ]);
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
      ).toBe(2);
    } finally {
      harness.unmount();
    }
  });

  test("manual failure retains associations as stale and a later refresh clears the error", async () => {
    history = [rawPr(1, "MERGED")];
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await settle();
      listError = "incomplete pagination";
      await harness.value.refresh();
      await settle();
      expect(harness.value.errors.get("/tmp/repo")).toContain(listError);
      expect(
        harness.value.associations.get(key("/tmp/repo", "feature"))?.lastError,
      ).toContain(listError);
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
      ).toBe(1);
      listError = null;
      await poll();
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "all",
        "open",
      ]);
      expect(harness.value.errors.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("focused identity errors and incomplete details propagate instead of looking fresh", async () => {
    history = [rawPr(1, "MERGED")];
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await settle();
      getError = "identity unavailable";
      await poll();
      expect(harness.value.errors.get("/tmp/repo")).toContain(getError);
      getError = null;
      detailError = "incomplete checks";
      await harness.value.refresh();
      await settle();
      expect(harness.value.errors.get("/tmp/repo")).toBe(detailError);
      expect(
        harness.value.associations.get(key("/tmp/repo", "feature"))?.lastError,
      ).toBe(detailError);
      detailError = null;
      await poll();
      expect(harness.value.errors.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("targeted refresh isolates repositories with the same display name", async () => {
    listError = "offline";
    const harness = await renderHook([repo("/tmp/a"), repo("/tmp/b")]);
    try {
      await settle();
      list.mockClear();
      listError = "retry failed";
      await harness.value.refresh("/tmp/a");
      await settle();
      expect(list).toHaveBeenCalledTimes(1);
      expect(harness.value.errors.get("/tmp/a")).toContain("retry failed");
      expect(harness.value.errors.get("/tmp/b")).toContain("offline");
      list.mockClear();
      await harness.value.refresh("same-name");
      expect(list).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });

  test("manual discovery waits for an in-flight poll then performs a complete request", async () => {
    const harness = await renderHook([repo()]);
    try {
      await settle();
      let release!: () => void;
      holdList = new Promise((resolve) => {
        release = resolve;
      });
      await poll();
      const manual = harness.value.refresh();
      await settle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all", "open"]);
      holdList = null;
      release();
      await manual;
      await settle();
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "open",
        "all",
      ]);
    } finally {
      harness.unmount();
    }
  });

  test("explicit changes and post-submission reads wait for older requests and use focused refresh", async () => {
    history = [rawPr(1)];
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await settle();
      let release!: () => void;
      holdList = new Promise((resolve) => {
        release = resolve;
      });
      await poll();
      const update = harness.value.setExplicit("/tmp/repo", "feature", {
        baseRepository: "base/repo",
        number: 1,
      } as PrFacts);
      await settle();
      expect(list).toHaveBeenCalledTimes(2);
      holdList = null;
      release();
      await update;
      await settle();
      expect(
        harness.value.associations.get(key("/tmp/repo", "feature"))?.explicit,
      ).toBe(true);
      history[0] = rawPr(1, "MERGED");
      await harness.value.refreshAfterCurrent("/tmp/repo");
      await settle();
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "open",
        "open",
        "open",
      ]);
      expect(harness.value.prData.get(key("/tmp/repo", "feature"))?.state).toBe(
        "MERGED",
      );
    } finally {
      harness.unmount();
    }
  });

  test("a changed base repository triggers complete discovery", async () => {
    const harness = await renderHook([repo()]);
    try {
      await settle();
      base = "new/repo";
      await poll();
      expect(list.mock.calls.map((call) => call.slice(1))).toEqual([
        ["all", "base/repo"],
        ["all", "new/repo"],
      ]);
    } finally {
      harness.unmount();
    }
  });

  test("queued manual discovery uses current Workspaces and preserves their Explicit PR Associations", async () => {
    let release!: () => void;
    holdList = new Promise((resolve) => {
      release = resolve;
    });
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await settle();
      const manual = harness.value.refresh();
      explicitCache.set(key("/tmp/repo", "second"), {
        baseRepository: "base/repo",
        number: 2,
      });
      history = [rawPr(2, "MERGED", "second")];
      harness.rerender([repo("/tmp/repo", ["feature", "second"])]);
      await settle();
      holdList = null;
      release();
      await manual;
      await settle();
      expect(explicitCache.get(key("/tmp/repo", "second"))?.number).toBe(2);
      expect(
        harness.value.associations.get(key("/tmp/repo", "second")),
      ).toMatchObject({ explicit: true, pr: { number: 2 } });
    } finally {
      harness.unmount();
    }
  });

  test("a topology change during manual discovery cannot prune new explicit choices", async () => {
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await settle();
      let release!: () => void;
      holdList = new Promise((resolve) => {
        release = resolve;
      });
      const manual = harness.value.refresh();
      await settle();
      explicitCache.set(key("/tmp/repo", "second"), {
        baseRepository: "base/repo",
        number: 2,
      });
      history = [rawPr(2, "MERGED", "second")];
      harness.rerender([repo("/tmp/repo", ["feature", "second"])]);
      await settle();
      holdList = null;
      release();
      await manual;
      await settle();
      expect(explicitCache.get(key("/tmp/repo", "second"))?.number).toBe(2);
      expect(
        harness.value.associations.get(key("/tmp/repo", "second")),
      ).toMatchObject({ explicit: true, pr: { number: 2 } });
    } finally {
      harness.unmount();
    }
  });

  test("repository changes abort old requests before updating the discovery snapshot", async () => {
    let release!: () => void;
    holdList = new Promise((resolve) => {
      release = resolve;
    });
    const harness = await renderHook([repo()]);
    try {
      await settle();
      expect(list).toHaveBeenCalledTimes(1);
      harness.rerender([repo("/tmp/repo", ["feature"])]);
      await settle();
      expect(list).toHaveBeenCalledTimes(2);
      holdList = null;
      release();
      await settle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all", "all"]);
      await poll();
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "all",
        "open",
      ]);
      expect(harness.value.errors.size).toBe(0);
      expect(harness.value.refreshingProjects.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });
});

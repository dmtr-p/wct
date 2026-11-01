import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Fiber } from "effect";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { commandError } from "../../src/errors";
import { runMigrations } from "../../src/services/db";
import { GitHubService } from "../../src/services/github-service";
import {
  RegistrationId,
  type WorkspaceIdentityKey,
  workspaceIdentityKey,
} from "../../src/services/identities";
import {
  type ExplicitPrAssociation,
  livePrCacheService,
  PrCacheService,
  type PrCacheServiceApi,
  type PrDiscoverySnapshot,
  sqlGetOpenPrs,
  sqlGetWorkspace,
  sqlSetOpenPrs,
  type WorkspacePrEntry,
} from "../../src/services/pr-cache-service";
import { normalizeGhPr } from "../../src/services/pr-discovery";
import type { MergeSnapshot } from "../../src/services/pr-merge-service";
import type { OpenPrChoice, PrFacts } from "../../src/services/pr-model";
import {
  makePrRefreshService,
  PrRefreshService,
  type PrRefreshServiceApi,
} from "../../src/services/pr-refresh-service";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";
import { createPrActionsController } from "../../src/tui/pr-actions";
import { Mode } from "../../src/tui/types";

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: vi.fn(),
    runFork: vi.fn(),
    runSync: vi.fn(() => null),
  },
}));
vi.mock("../../src/services/pr-discovery", async () => ({
  ...(await vi.importActual<typeof import("../../src/services/pr-discovery")>(
    "../../src/services/pr-discovery",
  )),
  resolvePushDestination: (_cwd: string, branch: string) =>
    Effect.promise(async () => {
      activeDestinations++;
      peakDestinations = Math.max(peakDestinations, activeDestinations);
      try {
        if (destinationGate) await destinationGate;
      } finally {
        activeDestinations--;
      }
    }).pipe(
      Effect.flatMap(() =>
        failWorkspaceReads
          ? Effect.fail(commandError("pr_error", "workspace unavailable"))
          : Effect.succeed(
              branch === "unknown" ? null : { repository: "fork/repo", branch },
            ),
      ),
    ),
}));
vi.mock("../../src/services/pr-details", () => ({
  fetchPrDetails: (_cwd: string, _base: string, prs: PrFacts[]) =>
    Effect.sync(() => {
      detailCalls.push(prs.map((pr) => pr.number));
      return prs.map((pr) => ({
        ...pr,
        checks: [],
        checksComplete: !(detailError ?? detailErrors.get(pr.number)),
        lastError: detailError ?? detailErrors.get(pr.number) ?? null,
      }));
    }),
}));
const { tuiRuntime } = await import("../../src/tui/runtime");
const { useGitHub } = await import("../../src/tui/hooks/useGitHub");
const runPromise = vi.mocked(tuiRuntime.runPromise);
const runFork = vi.mocked(tuiRuntime.runFork);
const runSync = vi.mocked(tuiRuntime.runSync);
const pendingEffects = new Set<Promise<unknown>>();
const ownerFibers = new Set<Fiber.Fiber<unknown, unknown>>();

function rawPr(
  number: number,
  state = "OPEN",
  branch = "feature",
  head = "fork/repo",
  headOid: string | null = `oid-${number}`,
) {
  return {
    number,
    state,
    title: `PR ${number}`,
    headRefName: branch,
    headRepository: { nameWithOwner: head },
    headRefOid: headOid,
    updatedAt: new Date(Date.now() + number).toISOString(),
  };
}
let history: ReturnType<typeof rawPr>[];
let listError: string | null;
let detailError: string | null;
let getError: string | null;
let base: string;
let holdList: Promise<void> | null;
let failDiscoveryWrites: boolean;
let removedRegistration: boolean;
let failWorkspaceReads: boolean;
let discoveryWrites: number;
let baseError: string | null;
let destinationGate: Promise<void> | null;
let activeDestinations: number;
let peakDestinations: number;
let heldRepo: string | null;
const detailErrors = new Map<number, string>();
const detailCalls: number[][] = [];
const discoveryCache = new Map<string, PrDiscoverySnapshot>();
const openCache = new Map<string, OpenPrChoice[]>();
const baseRead = vi.fn(() =>
  Effect.suspend(() =>
    baseError
      ? Effect.fail(commandError("pr_error", baseError))
      : Effect.succeed(base),
  ),
);
const batchGet = vi.fn(
  (cwd: string, repository: string, numbers: readonly number[]) =>
    Effect.forEach(numbers, (number) =>
      get(cwd, repository, number).pipe(
        Effect.map((raw) => ({ number, raw, error: null as string | null })),
        Effect.catch((error) =>
          Effect.succeed({ number, raw: null, error: error.message }),
        ),
      ),
    ),
);
const list = vi.fn(
  (_cwd: string, state: "all" | "updated", _base: string, since?: number) =>
    Effect.promise(async () => {
      if (holdList && (!heldRepo || heldRepo === _cwd)) await holdList;
    }).pipe(
      Effect.flatMap(() =>
        listError
          ? Effect.fail(commandError("pr_error", listError))
          : Effect.succeed(
              history
                .filter(
                  (pr) =>
                    state === "all" || Date.parse(pr.updatedAt) >= (since ?? 0),
                )
                .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
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
  resolveBaseRepo: baseRead,
  listRawPrs: list,
  getRawPrs: batchGet,
});
const workspaceCache = new Map<WorkspaceIdentityKey, WorkspacePrEntry>();
const explicitCache = new Map<WorkspaceIdentityKey, ExplicitPrAssociation>();
const key = workspaceIdentityKey;
const hydrationRead = vi.fn<PrCacheServiceApi["getHydration"]>(
  (path: string, branches: readonly string[], includeOpenPrs: boolean) =>
    Effect.sync(() => {
      const choices = includeOpenPrs ? openCache.get(path) : undefined;
      return {
        workspaces: branches.map((branch) => ({
          branch,
          cached: workspaceCache.get(key(path, branch)) ?? null,
        })),
        openPrs: choices
          ? { payload: choices, fetchedAt: 1, lastError: null }
          : null,
      };
    }),
);
const cache = PrCacheService.of({
  ...livePrCacheService,
  withWriteBatch: (writes) => writes,
  getHydration: hydrationRead,
  getWorkspaceInputs: (path, branches) =>
    Effect.sync(() =>
      branches.map((branch) => ({
        branch,
        explicit: explicitCache.get(key(path, branch)) ?? null,
        cached: workspaceCache.get(key(path, branch)) ?? null,
      })),
    ),
  getDiscovery: (path) => Effect.sync(() => discoveryCache.get(path) ?? null),
  setDiscovery: (path, snapshot) =>
    Effect.sync(() => {
      discoveryWrites++;
      if (failDiscoveryWrites) throw new Error("cache write failed");
      if (removedRegistration) return false;
      discoveryCache.set(path, snapshot);
      return true;
    }),
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
  setExplicit: (path, branch, association) =>
    Effect.sync(() => {
      explicitCache.set(key(path, branch), association);
    }),
  clearExplicit: (path, branch) =>
    Effect.sync(() => {
      explicitCache.delete(key(path, branch));
    }),
  setOpenPrs: (path, prs) =>
    Effect.sync(() => {
      openCache.set(path, prs);
    }),
  pruneWorkspaces: (path, branches) =>
    Effect.sync(() => {
      for (const identity of explicitCache.keys())
        if (
          identity.startsWith(key(path, "")) &&
          !branches.includes(identity.slice(path.length + 1))
        )
          explicitCache.delete(identity);
    }),
});

function repo(path = "/tmp/repo", branches: string[] = []): RepoInfo {
  return {
    id: RegistrationId(path),
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

function repoWithMainWorktree(branch = "feature"): RepoInfo {
  const result = repo("/tmp/repo", [branch, "second"]);
  result.worktrees = result.worktrees.map((wt, index) =>
    index === 0 ? { ...wt, path: result.repoPath, isMainWorktree: true } : wt,
  );
  return result;
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
  const waitFor = (assertion: () => void) =>
    vi.waitFor(
      async () => {
        await instance.waitUntilRenderFlush();
        assertion();
      },
      { interval: 1 },
    );
  return {
    get value() {
      if (!value) throw new Error("Missing hook value");
      return value;
    },
    rerender: (nextRepos: RepoInfo[]) =>
      instance.rerender(React.createElement(Hook, { repos: nextRepos })),
    flush: () => instance.waitUntilRenderFlush(),
    waitFor,
    waitForIdle: async () => {
      // Let passive effects submit session work before checking tracked waiters.
      await instance.waitUntilRenderFlush();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await waitFor(() => {
        expect(pendingEffects.size).toBe(0);
        expect(value?.refreshingProjects.size).toBe(0);
      });
      await instance.waitUntilRenderFlush();
    },
    unmount: () => instance.unmount(),
  };
}
async function poll(harness: Awaited<ReturnType<typeof renderHook>>) {
  vi.advanceTimersByTime(120_000);
  await harness.waitForIdle();
}

function cachedWorkspace(number: number, branch = "feature"): WorkspacePrEntry {
  return {
    pr: normalizeGhPr(rawPr(number, "MERGED", branch), "base/repo", 1),
    candidates: [],
    newerOpenPr: null,
    fetchedAt: 1,
    lastError: null,
  };
}

function cachedChoice(number: number): OpenPrChoice {
  return {
    number,
    title: `Cached PR ${number}`,
    state: "OPEN",
    headRefName: "feature",
  };
}

describe("useGitHub", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    history = [];
    listError = detailError = getError = null;
    baseError = null;
    destinationGate = null;
    activeDestinations = peakDestinations = 0;
    base = "base/repo";
    holdList = null;
    heldRepo = null;
    failDiscoveryWrites = removedRegistration = false;
    failWorkspaceReads = false;
    discoveryWrites = 0;
    detailErrors.clear();
    detailCalls.length = 0;
    discoveryCache.clear();
    openCache.clear();
    baseRead.mockClear();
    batchGet.mockClear();
    workspaceCache.clear();
    hydrationRead.mockClear();
    explicitCache.clear();
    list.mockClear();
    get.mockClear();
    runSync.mockReset();
    runSync.mockImplementation((<A, E>(
      effect: Effect.Effect<A, E, PrCacheServiceApi>,
    ) =>
      Effect.runSync(
        effect.pipe(Effect.provideService(PrCacheService, cache)),
      )) as typeof tuiRuntime.runSync);
    runPromise.mockReset();
    runFork.mockReset();
    pendingEffects.clear();
    const provide = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        GitHubService | PrCacheServiceApi | PrRefreshServiceApi
      >,
    ) =>
      effect.pipe(
        Effect.provideServiceEffect(PrRefreshService, makePrRefreshService),
        Effect.provide(BunServices.layer),
        Effect.provideService(GitHubService, github),
        Effect.provideService(PrCacheService, cache),
      );
    runFork.mockImplementation((<A, E>(
      effect: Effect.Effect<
        A,
        E,
        GitHubService | PrCacheServiceApi | PrRefreshServiceApi
      >,
      options?: Effect.RunOptions,
    ) => {
      const fiber = Effect.runFork(provide(effect), options);
      ownerFibers.add(fiber);
      fiber.addObserver(() => ownerFibers.delete(fiber));
      return fiber;
    }) as typeof tuiRuntime.runFork);
    runPromise.mockImplementation((<A, E>(
      effect: Effect.Effect<A, E, GitHubService | PrCacheServiceApi>,
      options?: { signal?: AbortSignal },
    ) => {
      const promise = Effect.runPromise(provide(effect), options);
      pendingEffects.add(promise);
      const complete = () => {
        pendingEffects.delete(promise);
      };
      void promise.then(complete, complete);
      return promise;
    }) as typeof tuiRuntime.runPromise);
  });
  afterEach(async () => {
    await Effect.runPromise(Fiber.interruptAll(ownerFibers));
    await Promise.allSettled(pendingEffects);
    vi.useRealTimers();
  });

  test("automatically associates and persists main and linked worktree PRs", async () => {
    history = [
      rawPr(1),
      rawPr(2, "OPEN", "second"),
      rawPr(3, "OPEN", "feature", "other/repo"),
    ];
    const harness = await renderHook([repoWithMainWorktree()]);
    try {
      await harness.waitForIdle();
      await poll(harness);
      for (const [branch, number] of [
        ["feature", 1],
        ["second", 2],
      ] as const) {
        const identity = key("/tmp/repo", branch);
        expect(harness.value.prData.get(identity)).toMatchObject({
          baseRepository: "base/repo",
          headRepository: "fork/repo",
          number,
        });
        expect(workspaceCache.get(identity)).toMatchObject({
          explicit: false,
          pr: { number },
          lastError: null,
        });
      }
      expect(harness.value.errors.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test.each([
    {
      reason: "unknown Push Destination",
      branch: "unknown",
      prs: [rawPr(1, "OPEN", "unknown")],
      candidates: [1],
    },
    {
      reason: "different head repository",
      branch: "feature",
      prs: [rawPr(1, "OPEN", "feature", "other/repo")],
      candidates: [],
    },
    {
      reason: "ambiguous open PRs",
      branch: "feature",
      prs: [rawPr(1), rawPr(3)],
      candidates: [1, 3],
    },
  ])(
    "keeps a main-worktree association unresolved with $reason",
    async ({ branch, prs, candidates }) => {
      history = [...prs, rawPr(2, "OPEN", "second")];
      const harness = await renderHook([repoWithMainWorktree(branch)]);
      try {
        await harness.waitForIdle();
        const entry = harness.value.associations.get(key("/tmp/repo", branch));
        expect(entry).toMatchObject({ pr: null, explicit: false });
        expect(
          entry?.candidates.map((pr) => pr.number).sort((a, b) => a - b),
        ).toEqual(candidates);
        expect(
          harness.value.prData.get(key("/tmp/repo", "second"))?.number,
        ).toBe(2);
      } finally {
        harness.unmount();
      }
    },
  );

  test("preserves a main-worktree Explicit PR Association through pruning and refresh failures", async () => {
    history = [rawPr(1), rawPr(2, "OPEN", "second")];
    const identity = key("/tmp/repo", "feature");
    const explicit = { baseRepository: "external/repo", number: 8 };
    explicitCache.set(identity, explicit);
    explicitCache.set(key("/tmp/repo", "removed"), explicit);
    const harness = await renderHook([repoWithMainWorktree()]);
    try {
      await harness.waitForIdle();
      const assertAssociations = (lastError: string | null) => {
        for (const [branch, number] of [
          ["feature", 8],
          ["second", 2],
        ] as const) {
          const workspace = key("/tmp/repo", branch);
          expect(harness.value.associations.get(workspace)).toMatchObject({
            pr: { number },
            explicit: branch === "feature",
            lastError,
          });
          expect(workspaceCache.get(workspace)).toMatchObject({
            pr: { number },
            lastError,
          });
        }
        expect(explicitCache.get(identity)).toEqual(explicit);
      };
      assertAssociations(null);
      expect(harness.value.prData.get(identity)).toMatchObject({
        baseRepository: "external/repo",
        state: "MERGED",
      });
      expect(explicitCache.has(key("/tmp/repo", "removed"))).toBe(false);
      listError = "discovery failed";
      await harness.value.refresh();
      await harness.waitForIdle();
      assertAssociations(listError);
      expect(harness.value.errors.get("/tmp/repo")).toContain(listError);
      listError = null;
      await poll(harness);
      assertAssociations(null);
      expect(harness.value.errors.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("does not fetch an empty registry", async () => {
    const harness = await renderHook([]);
    try {
      await harness.waitForIdle();
      expect(list).not.toHaveBeenCalled();
      expect(hydrationRead).not.toHaveBeenCalled();
      expect(harness.value.prData.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("unmount interrupts the owner and settles refreshes waiting for session acquisition", async () => {
    const start = Deferred.makeUnsafe<void>();
    const fork = runFork.getMockImplementation();
    if (!fork) throw new Error("Missing owner runner");
    runFork.mockImplementationOnce((<A, E>(
      effect: Effect.Effect<
        A,
        E,
        GitHubService | PrCacheServiceApi | PrRefreshServiceApi
      >,
      options?: Effect.RunOptions,
    ) =>
      fork(
        Effect.andThen(Deferred.await(start), effect),
        options,
      )) as typeof tuiRuntime.runFork);
    const harness = await renderHook([repo()]);
    try {
      await harness.waitFor(() => expect(runFork).toHaveBeenCalledTimes(1));
      const manual = harness.value.refresh();
      harness.unmount();
      await manual;
      await harness.waitFor(() => expect(ownerFibers.size).toBe(0));
      Effect.runSync(Deferred.succeed(start, undefined));
      expect(list).not.toHaveBeenCalled();
      expect(discoveryWrites).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("unmount releases active discovery and a new mount owns an independent session", async () => {
    let release!: () => void;
    holdList = new Promise((resolve) => {
      release = resolve;
    });
    const first = await renderHook([repo()]);
    try {
      await first.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      const manual = first.value.refresh();
      first.unmount();
      await manual;
      await first.waitFor(() => expect(ownerFibers.size).toBe(0));
      expect(discoveryWrites).toBe(0);
    } finally {
      first.unmount();
      holdList = null;
      release();
    }
    const second = await renderHook([repo()]);
    try {
      await second.waitForIdle();
      expect(ownerFibers.size).toBe(1);
      expect(list).toHaveBeenCalledTimes(2);
      expect(discoveryWrites).toBe(1);
    } finally {
      second.unmount();
    }
  });

  test.each(["hit", "miss"])(
    "hydrates a cache %s once across startup and unchanged registry polls",
    async (result) => {
      const path = "/tmp/repo";
      const branches = Array.from(
        { length: 20 },
        (_, index) => `branch-${index}`,
      );
      if (result === "hit") {
        for (const branch of branches)
          workspaceCache.set(key(path, branch), cachedWorkspace(1, branch));
        openCache.set(path, [cachedChoice(1)]);
      }
      listError = "offline";
      const harness = await renderHook([repo(path, branches)]);
      try {
        await harness.waitForIdle();
        expect(hydrationRead.mock.calls).toEqual([[path, branches, true]]);
        const associations = harness.value.associations;
        const choices = harness.value.openPrs;
        for (let index = 0; index < 3; index++) {
          vi.advanceTimersByTime(5000);
          harness.rerender([
            { ...repo(path, branches), project: `renamed-${index}` },
          ]);
          await harness.waitForIdle();
        }
        expect(hydrationRead).toHaveBeenCalledTimes(1);
        expect(harness.value.associations).toBe(associations);
        expect(harness.value.openPrs).toBe(choices);
        expect(associations.size).toBe(result === "hit" ? 20 : 0);
        expect(choices.get(path)).toEqual(
          result === "hit" ? [cachedChoice(1)] : undefined,
        );
      } finally {
        harness.unmount();
      }
    },
  );

  test("hydrates only new Workspaces and registrations while preserving in-memory facts", async () => {
    const path = "/tmp/repo";
    workspaceCache.set(key(path, "feature"), cachedWorkspace(1));
    openCache.set(path, [cachedChoice(1)]);
    listError = "offline";
    const harness = await renderHook([repo(path, ["feature"])]);
    let release!: () => void;
    try {
      await harness.waitForIdle();
      workspaceCache.set(key(path, "feature"), cachedWorkspace(99));
      openCache.set(path, [cachedChoice(99)]);
      workspaceCache.set(key(path, "new"), cachedWorkspace(2, "new"));
      workspaceCache.set(key("/tmp/other", "feature"), cachedWorkspace(3));
      openCache.set("/tmp/other", [cachedChoice(3)]);
      holdList = new Promise((resolve) => {
        release = resolve;
      });
      harness.rerender([
        repo(path, ["feature", "new"]),
        repo("/tmp/other", ["feature"]),
      ]);
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expect(hydrationRead.mock.calls).toEqual([
        [path, ["feature"], true],
        [path, ["new"], false],
        ["/tmp/other", ["feature"], true],
      ]);
      expect(harness.value.prData.get(key(path, "feature"))?.number).toBe(1);
      expect(harness.value.prData.get(key(path, "new"))?.number).toBe(2);
      expect(
        harness.value.prData.get(key("/tmp/other", "feature"))?.number,
      ).toBe(3);
      expect(harness.value.openPrs.get(path)).toEqual([cachedChoice(1)]);
      expect(harness.value.openPrs.get("/tmp/other")).toEqual([
        cachedChoice(3),
      ]);
      release();
      await harness.waitForIdle();
    } finally {
      release?.();
      harness.unmount();
    }
  });

  test.each([true, false])(
    "rehydrates reappearing Workspaces while offline (inspection failure: %s)",
    async (inspectionFailure) => {
      const path = "/tmp/repo";
      history = [rawPr(1)];
      const harness = await renderHook([repo(path, ["feature"])]);
      try {
        await harness.waitForIdle();
        expect(harness.value.prData.get(key(path, "feature"))?.number).toBe(1);
        harness.rerender([
          {
            ...repo(path),
            ...(inspectionFailure
              ? { error: "Failed to inspect repository" }
              : {}),
          },
        ]);
        await harness.waitForIdle();
        expect(harness.value.associations.has(key(path, "feature"))).toBe(
          false,
        );
        if (!inspectionFailure) {
          // Another TUI can populate the cache after successful removal prunes it.
          workspaceCache.clear();
          workspaceCache.set(key(path, "feature"), cachedWorkspace(2));
        }
        vi.advanceTimersByTime(31_000);
        listError = "offline";
        harness.rerender([repo(path, ["feature"])]);
        await harness.waitForIdle();
        expect(hydrationRead.mock.calls).toEqual([
          [path, ["feature"], true],
          [path, ["feature"], false],
        ]);
        expect(harness.value.prData.get(key(path, "feature"))?.number).toBe(
          inspectionFailure ? 1 : 2,
        );
        expect(harness.value.errors.get(path)).toContain("offline");
        harness.rerender([repo(path, ["feature"])]);
        await harness.waitForIdle();
        expect(hydrationRead).toHaveBeenCalledTimes(2);
      } finally {
        harness.unmount();
      }
    },
  );

  test.each([true, false])(
    "resets hydration on re-registration (observed removal: %s)",
    async (observeRemoval) => {
      const path = "/tmp/repo";
      workspaceCache.set(key(path, "feature"), cachedWorkspace(1));
      workspaceCache.set(key(path, "old"), cachedWorkspace(9, "old"));
      openCache.set(path, [cachedChoice(1)]);
      listError = "offline";
      const harness = await renderHook([repo(path, ["feature", "old"])]);
      let release!: () => void;
      try {
        await harness.waitForIdle();
        if (observeRemoval) {
          harness.rerender([]);
          await harness.waitForIdle();
          expect(harness.value.associations.size).toBe(0);
          expect(harness.value.openPrs.size).toBe(0);
        }
        workspaceCache.clear();
        workspaceCache.set(key(path, "feature"), cachedWorkspace(2));
        openCache.set(path, [cachedChoice(2)]);
        holdList = new Promise((resolve) => {
          release = resolve;
        });
        harness.rerender([
          {
            ...repo(path, ["feature"]),
            id: RegistrationId("new-registration"),
          },
        ]);
        await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
        expect(hydrationRead.mock.calls).toEqual([
          [path, ["feature", "old"], true],
          [path, ["feature"], true],
        ]);
        expect(harness.value.prData.get(key(path, "feature"))?.number).toBe(2);
        expect(harness.value.associations.has(key(path, "old"))).toBe(false);
        expect(harness.value.openPrs.get(path)).toEqual([cachedChoice(2)]);
        release();
        await harness.waitForIdle();
      } finally {
        release?.();
        harness.unmount();
      }
    },
  );

  test("retries failed hydration on a registry update and remembers the successful miss", async () => {
    hydrationRead.mockReturnValueOnce(
      Effect.fail(commandError("pr_cache_error", "unavailable")),
    );
    hydrationRead.mockReturnValueOnce(
      Effect.fail(commandError("pr_cache_error", "unavailable")),
    );
    listError = "offline";
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      expect(hydrationRead).toHaveBeenCalledTimes(2);
      harness.rerender([repo("/tmp/repo", ["feature"])]);
      await harness.waitForIdle();
      expect(hydrationRead).toHaveBeenCalledTimes(3);
      harness.rerender([repo("/tmp/repo", ["feature"])]);
      await harness.waitForIdle();
      expect(hydrationRead).toHaveBeenCalledTimes(3);
    } finally {
      harness.unmount();
    }
  });

  test("a hydration retry cannot overwrite newer GitHub facts already in memory", async () => {
    hydrationRead.mockReturnValueOnce(
      Effect.fail(commandError("pr_cache_error", "unavailable")),
    );
    hydrationRead.mockReturnValueOnce(
      Effect.fail(commandError("pr_cache_error", "unavailable")),
    );
    history = [rawPr(1)];
    const path = "/tmp/repo";
    const harness = await renderHook([repo(path, ["feature"])]);
    try {
      await harness.waitForIdle();
      expect(harness.value.prData.get(key(path, "feature"))?.number).toBe(1);
      const association = harness.value.associations.get(key(path, "feature"));
      const choices = harness.value.openPrs.get(path);
      workspaceCache.set(key(path, "feature"), cachedWorkspace(99));
      openCache.set(path, [cachedChoice(99)]);
      harness.rerender([repo(path, ["feature"])]);
      await harness.waitForIdle();
      expect(hydrationRead).toHaveBeenCalledTimes(3);
      expect(harness.value.associations.get(key(path, "feature"))).toBe(
        association,
      );
      expect(harness.value.openPrs.get(path)).toBe(choices);
    } finally {
      harness.unmount();
    }
  });

  test("hydrates cached Open modal choices at startup and retains them when discovery fails", async () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const repoPath = "/tmp/repo";
    const choices: OpenPrChoice[] = [
      {
        number: 7,
        title: "Cached PR",
        state: "OPEN",
        headRefName: "feature",
      },
    ];
    sqlSetOpenPrs(database, repoPath, choices);
    const startupCache = PrCacheService.of({
      ...cache,
      getHydration: (path, branches, includeOpenPrs) =>
        Effect.sync(() => ({
          workspaces: branches.map((branch) => ({
            branch,
            cached: sqlGetWorkspace(database, path, branch),
          })),
          openPrs: includeOpenPrs ? sqlGetOpenPrs(database, path) : null,
        })),
    });
    runSync.mockImplementation((<A, E>(
      effect: Effect.Effect<A, E, PrCacheServiceApi>,
    ) =>
      Effect.runSync(
        effect.pipe(Effect.provideService(PrCacheService, startupCache)),
      )) as typeof tuiRuntime.runSync);
    let releaseRefresh!: () => void;
    holdList = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    listError = "offline";
    const harness = await renderHook([repo(repoPath, ["feature"])]);
    try {
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      expect(list).toHaveBeenCalledTimes(1);
      await harness.waitFor(() =>
        expect(harness.value.refreshingProjects.has(repoPath)).toBe(true),
      );
      expect(harness.value.openPrs.get(repoPath)).toEqual(choices);

      releaseRefresh();
      await harness.waitForIdle();
      expect(harness.value.errors.get(repoPath)).toContain("offline");
      expect(harness.value.refreshingProjects.has(repoPath)).toBe(false);
      expect(harness.value.openPrs.get(repoPath)).toEqual(choices);
      expect(harness.value.prData.size).toBe(0);
      expect(harness.value.associations.size).toBe(0);
    } finally {
      releaseRefresh();
      harness.unmount();
      runSync.mockReturnValue(null);
      database.close();
    }
  });

  test("derives the modal list from complete discovery then polls updates with a cached base", async () => {
    history = [rawPr(1), rawPr(2, "MERGED")];
    const harness = await renderHook([repo()]);
    try {
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all"]);
      expect(baseRead).toHaveBeenCalledTimes(1);
      expect(harness.value.refreshingProjects.size).toBe(0);
      expect(
        harness.value.openPrs.get("/tmp/repo")?.map((pr) => pr.number),
      ).toEqual([1]);
      expect(harness.value.openPrs.get("/tmp/repo")).toEqual([
        { number: 1, title: "PR 1", state: "OPEN", headRefName: "feature" },
      ]);
      expect(openCache.get("/tmp/repo")).toEqual(
        harness.value.openPrs.get("/tmp/repo"),
      );
      expect(harness.value.prData.size).toBe(0);
      await poll(harness);
      await poll(harness);
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
        "updated",
      ]);
      expect(get).not.toHaveBeenCalled();
      expect(baseRead).toHaveBeenCalledTimes(1);
    } finally {
      harness.unmount();
    }
  });

  test("routine polls make no summary or check calls for dozens of terminal candidates", async () => {
    history = Array.from({ length: 60 }, (_, i) => rawPr(i + 1, "MERGED"));
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      const initiallyDetailed = detailCalls.flat();
      expect(initiallyDetailed).toHaveLength(1);
      detailCalls.length = 0;
      await poll(harness);
      await poll(harness);
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
        "updated",
      ]);
      expect(batchGet).not.toHaveBeenCalled();
      expect(detailCalls).toEqual([]);
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
      ).toBe(initiallyDetailed[0]);
    } finally {
      harness.unmount();
    }
  });

  test("bounds push-destination work for large worktree lists", async () => {
    let release!: () => void;
    destinationGate = new Promise((resolve) => {
      release = resolve;
    });
    const harness = await renderHook([
      repo(
        "/tmp/repo",
        Array.from({ length: 40 }, (_, index) => `feature-${index}`),
      ),
    ]);
    try {
      await harness.waitFor(() => expect(activeDestinations).toBe(4));
      expect(activeDestinations).toBe(4);
      release();
      destinationGate = null;
      await harness.waitForIdle();
      expect(peakDestinations).toBe(4);
      expect(harness.value.refreshingProjects.size).toBe(0);
    } finally {
      release();
      harness.unmount();
    }
  });

  test.each(["MERGED", "CLOSED"])(
    "failed details cannot replace newly discovered %s facts with cached OPEN facts",
    async (state) => {
      history = [{ ...rawPr(1), headRefOid: "old-head" }];
      const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
      try {
        await harness.waitForIdle();
        detailError = "details unavailable";
        history = [rawPr(1, state)];
        await poll(harness);
        const pr = harness.value.prData.get(key("/tmp/repo", "feature"));
        expect(pr?.state).toBe(state);
        expect(pr?.checksComplete).toBe(false);
        expect(pr?.lastError).toBe(detailError);
      } finally {
        harness.unmount();
      }
    },
  );

  test("terminal associations with unknown heads do not reuse complete checks on later polls", async () => {
    history = [
      {
        ...rawPr(1, "MERGED", "feature", "fork/repo", null),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      rawPr(2, "MERGED", "other"),
    ];
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      expect(detailCalls).toEqual([[1]]);
      await poll(harness);
      expect(detailCalls).toEqual([[1], [1]]);
      harness.unmount();
      const reopened = await renderHook([repo("/tmp/repo", ["feature"])]);
      try {
        await reopened.waitForIdle();
        expect(list.mock.calls.map((call) => call[1])).toEqual([
          "all",
          "updated",
        ]);
        expect(detailCalls).toEqual([[1], [1], [1]]);
      } finally {
        reopened.unmount();
      }
    } finally {
      harness.unmount();
    }
  });

  test("a newly linked local OPEN PR reaches the Open list and snapshot immediately", async () => {
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      get.mockReturnValueOnce(Effect.succeed(rawPr(99)));
      await harness.value.setExplicit("/tmp/repo", "feature", {
        baseRepository: "base/repo",
        number: 99,
      } as PrFacts);
      await harness.waitForIdle();
      expect(
        harness.value.openPrs.get("/tmp/repo")?.map((pr) => pr.number),
      ).toEqual([99]);
      expect(discoveryCache.get("/tmp/repo")?.openNumbers).toEqual([99]);
      expect(openCache.get("/tmp/repo")?.map((pr) => pr.number)).toEqual([99]);
    } finally {
      harness.unmount();
    }
  });

  test("cleared external Explicit PR Associations are pruned from discovery", async () => {
    explicitCache.set(key("/tmp/repo", "feature"), {
      baseRepository: "external/repo",
      number: 99,
    });
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      expect(discoveryCache.get("/tmp/repo")?.explicitPrs).toHaveLength(1);
      await harness.value.clearExplicit("/tmp/repo", "feature");
      await harness.waitForIdle();
      expect(discoveryCache.get("/tmp/repo")?.explicitPrs).toEqual([]);
    } finally {
      harness.unmount();
    }
  });

  test("failed base resolution backs off automatic requests but manual refresh retries", async () => {
    baseError = "not authenticated";
    const harness = await renderHook([repo()]);
    try {
      await harness.waitForIdle();
      await poll(harness);
      await poll(harness);
      expect(baseRead).toHaveBeenCalledTimes(1);
      expect(list).not.toHaveBeenCalled();
      expect(harness.value.refreshingProjects.size).toBe(0);
      baseError = null;
      await harness.value.refresh();
      await harness.waitForIdle();
      expect(baseRead).toHaveBeenCalledTimes(2);
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all"]);
      expect(harness.value.errors.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("a queued manual refresh runs after a failed automatic discovery", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    list.mockImplementationOnce(() =>
      Effect.promise(() => gate).pipe(
        Effect.andThen(Effect.fail(commandError("pr_error", "offline"))),
      ),
    );
    const harness = await renderHook([repo()]);
    try {
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      const manual = harness.value.refresh();
      release();
      await manual;
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all", "all"]);
      expect(harness.value.errors.size).toBe(0);
    } finally {
      release();
      harness.unmount();
    }
  });

  test("a failed explicit identity leaves healthy associations and persisted discovery available", async () => {
    history = [rawPr(1)];
    explicitCache.set(key("/tmp/repo", "second"), {
      baseRepository: "external/repo",
      number: 8,
    });
    getError = "fork unavailable";
    const harness = await renderHook([
      repo("/tmp/repo", ["feature", "second"]),
    ]);
    try {
      await harness.waitForIdle();
      expect(
        discoveryCache.get("/tmp/repo")?.prs.map((pr) => pr.number),
      ).toEqual([1]);
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
      ).toBe(1);
      expect(
        harness.value.associations.get(key("/tmp/repo", "feature"))?.lastError,
      ).toBeNull();
      expect(
        harness.value.associations.get(key("/tmp/repo", "second"))?.lastError,
      ).toContain(getError);
      await poll(harness);
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
      ]);
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
      ).toBe(1);
    } finally {
      harness.unmount();
    }
  });

  test("a healthy explicit association does not inherit sibling check errors", async () => {
    history = [rawPr(1), rawPr(2)];
    explicitCache.set(key("/tmp/repo", "feature"), {
      baseRepository: "base/repo",
      number: 1,
    });
    detailErrors.set(2, "incomplete sibling checks");
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      await poll(harness);
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.lastError,
      ).toBeNull();
      expect(
        harness.value.associations.get(key("/tmp/repo", "feature"))?.lastError,
      ).toBeNull();
      expect(harness.value.errors.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("new TUI sessions reuse persistent discovery, skip fresh reads, then poll only open PRs", async () => {
    history = [rawPr(1, "MERGED")];
    const first = await renderHook([repo("/tmp/repo", ["feature"])]);
    await first.waitForIdle();
    first.unmount();
    list.mockClear();
    baseRead.mockClear();
    batchGet.mockClear();
    detailCalls.length = 0;
    const second = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await second.waitForIdle();
      expect(list).not.toHaveBeenCalled();
      expect(baseRead).not.toHaveBeenCalled();
      expect(detailCalls).toEqual([]);
      expect(second.value.prData.get(key("/tmp/repo", "feature"))?.number).toBe(
        1,
      );
      await poll(second);
      expect(list.mock.calls.map((call) => call[1])).toEqual(["updated"]);
    } finally {
      second.unmount();
    }
  });

  test.each(["post-merge", "set explicit", "clear explicit"])(
    "%s refresh bypasses automatic discovery backoff",
    async (action) => {
      listError = "offline";
      const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
      try {
        await harness.waitForIdle();
        listError = null;
        if (action === "post-merge")
          await harness.value.refreshAfterCurrent("/tmp/repo");
        else if (action === "set explicit")
          await harness.value.setExplicit("/tmp/repo", "feature", {
            baseRepository: "base/repo",
            number: 1,
          } as PrFacts);
        else await harness.value.clearExplicit("/tmp/repo", "feature");
        await harness.waitForIdle();
        expect(list.mock.calls.map((call) => call[1])).toEqual(["all", "all"]);
      } finally {
        harness.unmount();
      }
    },
  );

  test("a poll joining a modal refresh still receives fresh data when the modal closes", async () => {
    history = [rawPr(1)];
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      vi.advanceTimersByTime(31_000);
      let release!: () => void;
      holdList = new Promise((resolve) => {
        release = resolve;
      });
      const controller = new AbortController();
      const modal = harness.value.refreshCurrent(
        "/tmp/repo",
        controller.signal,
      );
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      const waitingPoll = harness.value.refreshCurrent("/tmp/repo");
      controller.abort();
      history[0] = rawPr(1, "MERGED");
      holdList = null;
      release();
      await Promise.all([modal, waitingPoll]);
      await harness.waitForIdle();
      expect(harness.value.prData.get(key("/tmp/repo", "feature"))?.state).toBe(
        "MERGED",
      );
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
      ]);
    } finally {
      harness.unmount();
    }
  });

  test("worktree changes in one repository do not restart another repository's discovery", async () => {
    let release!: () => void;
    heldRepo = "/tmp/a";
    holdList = new Promise((resolve) => {
      release = resolve;
    });
    const harness = await renderHook([repo("/tmp/a"), repo("/tmp/b")]);
    try {
      await harness.waitFor(() => {
        expect(list).toHaveBeenCalledTimes(2);
        expect(harness.value.refreshingProjects.has("/tmp/b")).toBe(false);
      });
      harness.rerender([repo("/tmp/a"), repo("/tmp/b", ["feature"])]);
      await harness.waitFor(() => {
        expect(pendingEffects.size).toBe(1);
        expect(harness.value.refreshingProjects.has("/tmp/b")).toBe(false);
      });
      expect(
        list.mock.calls.filter((call) => call[0] === "/tmp/a"),
      ).toHaveLength(1);
      expect(
        list.mock.calls.filter((call) => call[0] === "/tmp/b"),
      ).toHaveLength(1);
      holdList = null;
      release();
      await harness.waitForIdle();
      expect(discoveryCache.has("/tmp/a")).toBe(true);
    } finally {
      harness.unmount();
    }
  });

  test("concurrent manual refresh shares a full discovery already in progress", async () => {
    let release!: () => void;
    holdList = new Promise((resolve) => {
      release = resolve;
    });
    const harness = await renderHook([repo()]);
    try {
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      const manual = harness.value.refresh();
      holdList = null;
      release();
      await manual;
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all"]);
    } finally {
      harness.unmount();
    }
  });

  test("a PR merged between polls is discovered without manual refresh", async () => {
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      history.push(rawPr(1, "MERGED"));
      await poll(harness);
      expect(harness.value.prData.get(key("/tmp/repo", "feature"))?.state).toBe(
        "MERGED",
      );
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
      ]);
      expect(batchGet).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });

  test("saved history discovers PRs closed while the TUI was not running", async () => {
    const first = await renderHook([repo("/tmp/repo", ["feature"])]);
    await first.waitForIdle();
    first.unmount();
    vi.advanceTimersByTime(120_000);
    history = [rawPr(2, "CLOSED")];
    const second = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await second.waitForIdle();
      expect(second.value.prData.get(key("/tmp/repo", "feature"))?.number).toBe(
        2,
      );
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
      ]);
    } finally {
      second.unmount();
    }
  });

  test("a shared full scan still performs forced external and terminal reads for a manual request", async () => {
    history = [rawPr(1, "MERGED")];
    explicitCache.set(key("/tmp/repo", "feature"), {
      baseRepository: "external/repo",
      number: 8,
    });
    let release!: () => void;
    holdList = new Promise((resolve) => {
      release = resolve;
    });
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      const manual = harness.value.refresh();
      holdList = null;
      release();
      await manual;
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all"]);
      expect(batchGet).toHaveBeenCalledTimes(2);
      expect(detailCalls.flat().filter((number) => number === 8)).toHaveLength(
        2,
      );
    } finally {
      harness.unmount();
    }
  });

  test.each(["history", "workspace"])(
    "queued polls share a failed %s request without retrying it",
    async (failure) => {
      let release!: () => void;
      holdList = new Promise((resolve) => {
        release = resolve;
      });
      if (failure === "history") listError = "offline";
      else failWorkspaceReads = true;
      const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
      try {
        await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
        const waiting = [
          harness.value.refreshCurrent(),
          harness.value.refreshCurrent(),
        ];
        holdList = null;
        release();
        await Promise.all(waiting);
        await harness.waitForIdle();
        expect(list.mock.calls.map((call) => call[1])).toEqual(["all"]);
        expect(harness.value.errors.size).toBe(1);
      } finally {
        harness.unmount();
      }
    },
  );

  test("a cache write failure retains fetched history without a discovery retry delay", async () => {
    history = [rawPr(1, "MERGED")];
    failDiscoveryWrites = true;
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
      ).toBe(1);
      expect(harness.value.errors.get("/tmp/repo")).toContain(
        "cache write failed",
      );
      failDiscoveryWrites = false;
      await poll(harness);
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
      ]);
      expect(discoveryCache.get("/tmp/repo")?.prs[0]?.number).toBe(1);
      expect(harness.value.errors.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("discovery is persisted once per refresh and not rewritten for a fresh read", async () => {
    history = [rawPr(1, "MERGED")];
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      expect(discoveryWrites).toBe(1);
      await poll(harness);
      expect(discoveryWrites).toBe(2);
      await harness.value.refreshCurrent();
      await harness.waitForIdle();
      expect(discoveryWrites).toBe(2);
    } finally {
      harness.unmount();
    }
  });

  test("in-flight discovery cannot recreate a removed project's cache before the registry view updates", async () => {
    let release!: () => void;
    holdList = new Promise((resolve) => {
      release = resolve;
    });
    const harness = await renderHook([repo()]);
    try {
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      removedRegistration = true;
      discoveryCache.clear();
      holdList = null;
      release();
      await harness.waitForIdle();
      expect(discoveryCache.size).toBe(0);
      harness.rerender([]);
      await harness.waitForIdle();
      removedRegistration = false;
      harness.rerender([{ ...repo(), id: RegistrationId("new-registration") }]);
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all", "all"]);
    } finally {
      harness.unmount();
    }
  });

  test("re-registration while idle rebuilds history even when the UI never observed removal", async () => {
    history = [rawPr(1, "MERGED")];
    const harness = await renderHook([repo()]);
    try {
      await harness.waitForIdle();
      discoveryCache.clear();
      workspaceCache.clear();
      history.push(rawPr(2, "MERGED"));
      harness.rerender([{ ...repo(), id: RegistrationId("new-registration") }]);
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all", "all"]);
      expect(
        discoveryCache
          .get("/tmp/repo")
          ?.prs.map((pr) => pr.number)
          .toSorted(),
      ).toEqual([1, 2]);
    } finally {
      harness.unmount();
    }
  });

  test("mixed-case repository identities share a detail batch and use canonical spelling", async () => {
    base = "Owner/Repo";
    history = [rawPr(1)];
    explicitCache.set(key("/tmp/repo", "feature"), {
      baseRepository: "OWNER/REPO",
      number: 2,
    });
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      expect(detailCalls).toHaveLength(1);
      expect(detailCalls[0]?.toSorted((a, b) => a - b)).toEqual([1, 2]);
      expect(
        new Set(
          discoveryCache.get("/tmp/repo")?.prs.map((pr) => pr.baseRepository),
        ),
      ).toEqual(new Set(["owner/repo"]));
    } finally {
      harness.unmount();
    }
  });

  test("failed initial discovery delays automatic retries without caching failure", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    listError = "discovery timed out";
    const harness = await renderHook([repo()]);
    try {
      await harness.waitForIdle();
      listError = null;
      await poll(harness);
      await harness.value.refreshCurrent("/tmp/repo");
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all"]);
      expect(harness.value.errors.get("/tmp/repo")).toContain(
        "discovery timed out",
      );
      now.mockReturnValue(600_000);
      await poll(harness);
      now.mockReturnValue(720_000);
      await poll(harness);
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "all",
        "updated",
      ]);
      expect(harness.value.errors.size).toBe(0);
    } finally {
      harness.unmount();
      now.mockRestore();
    }
  });

  test("manual refresh bypasses the discovery retry delay", async () => {
    listError = "offline";
    const harness = await renderHook([repo()]);
    try {
      await harness.waitForIdle();
      listError = null;
      await harness.value.refresh();
      await poll(harness);
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "all",
        "updated",
      ]);
      expect(harness.value.errors.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("manual refresh can discover a changed base repository during discovery backoff", async () => {
    listError = "offline";
    const harness = await renderHook([repo()]);
    try {
      await harness.waitForIdle();
      listError = null;
      base = "new/repo";
      await poll(harness);
      expect(baseRead).toHaveBeenCalledTimes(1);
      await harness.value.refresh();
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call.slice(1, 3))).toEqual([
        ["all", "base/repo"],
        ["all", "new/repo"],
      ]);
      expect(harness.value.errors.size).toBe(0);
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
      await harness.waitForIdle();
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
      ).toBe(1);
      history[0] = rawPr(1, "MERGED");
      await poll(harness);
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
      ]);
      expect(get).not.toHaveBeenCalled();
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
      await harness.waitForIdle();
      await poll(harness);
      const entry = harness.value.associations.get(key("/tmp/repo", "feature"));
      expect(entry?.pr).toBeNull();
      expect(entry?.explicit).toBe(false);
      expect(
        entry?.candidates.map((pr) => pr.number).sort((a, b) => a - b),
      ).toEqual([1, 3]);
      const unknown = harness.value.associations.get(
        key("/tmp/repo", "unknown"),
      );
      expect(unknown?.pr).toBeNull();
      expect(unknown?.candidates.map((pr) => pr.number)).toEqual([4]);
      expect(get).not.toHaveBeenCalled();
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
      await harness.waitForIdle();
      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenLastCalledWith("/tmp/repo", "external/repo", 8);
      await poll(harness);
      expect(get.mock.calls.filter((call) => call[2] === 8)).toHaveLength(1);
      const entry = harness.value.associations.get(key("/tmp/repo", "feature"));
      expect(entry?.pr).toMatchObject({
        number: 8,
        state: "MERGED",
        baseRepository: "external/repo",
      });
      expect(entry?.explicit).toBe(true);
      expect(entry?.newerOpenPr).toBe(1);
      await harness.value.clearExplicit("/tmp/repo", "feature");
      await harness.waitForIdle();
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
      await harness.waitForIdle();
      harness.rerender([repo("/tmp/repo", ["old", "feature"])]);
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all"]);
      expect(harness.value.prData.get(key("/tmp/repo", "old"))?.number).toBe(1);
      history.push(rawPr(2, "CLOSED"));
      await poll(harness);
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
      ).toBe(2);
      await harness.value.refresh("/tmp/repo");
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
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
    history = [rawPr(1, "OPEN")];
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      await harness.waitFor(() =>
        expect(
          harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
        ).toBe(1),
      );
      listError = "incomplete pagination";
      await harness.value.refresh();
      await harness.waitForIdle();
      await harness.waitFor(() =>
        expect(harness.value.errors.get("/tmp/repo")).toContain(listError),
      );
      expect(
        harness.value.associations.get(key("/tmp/repo", "feature"))?.lastError,
      ).toContain(listError);
      expect(
        harness.value.prData.get(key("/tmp/repo", "feature"))?.number,
      ).toBe(1);
      listError = null;
      await poll(harness);
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "all",
        "updated",
      ]);
      expect(harness.value.errors.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("focused identity errors and incomplete details propagate instead of looking fresh", async () => {
    history = [rawPr(1, "OPEN")];
    explicitCache.set(key("/tmp/repo", "feature"), {
      baseRepository: "external/repo",
      number: 8,
    });
    get.mockReturnValueOnce(Effect.succeed(rawPr(8, "OPEN")));
    const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
    try {
      await harness.waitForIdle();
      getError = "identity unavailable";
      history[0] = rawPr(1, "MERGED");
      await poll(harness);
      expect(harness.value.errors.get("/tmp/repo")).toContain(getError);
      getError = null;
      detailError = "incomplete checks";
      await harness.value.refresh();
      await harness.waitForIdle();
      expect(harness.value.errors.get("/tmp/repo")).toBe(detailError);
      expect(
        harness.value.associations.get(key("/tmp/repo", "feature"))?.lastError,
      ).toBe(detailError);
      detailError = null;
      await poll(harness);
      expect(harness.value.errors.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  test("targeted refresh isolates repositories with the same display name", async () => {
    listError = "offline";
    const harness = await renderHook([repo("/tmp/a"), repo("/tmp/b")]);
    try {
      await harness.waitForIdle();
      list.mockClear();
      listError = "retry failed";
      await harness.value.refresh("/tmp/a");
      await harness.waitForIdle();
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
      await harness.waitForIdle();
      let release!: () => void;
      holdList = new Promise((resolve) => {
        release = resolve;
      });
      vi.advanceTimersByTime(120_000);
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      const manual = harness.value.refresh();
      await harness.flush();
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
      ]);
      holdList = null;
      release();
      await manual;
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
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
      await harness.waitForIdle();
      let release!: () => void;
      holdList = new Promise((resolve) => {
        release = resolve;
      });
      vi.advanceTimersByTime(120_000);
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      const update = harness.value.setExplicit("/tmp/repo", "feature", {
        baseRepository: "base/repo",
        number: 1,
      } as PrFacts);
      await harness.flush();
      expect(list).toHaveBeenCalledTimes(2);
      holdList = null;
      release();
      await update;
      await harness.waitForIdle();
      expect(
        harness.value.associations.get(key("/tmp/repo", "feature"))?.explicit,
      ).toBe(true);
      history[0] = rawPr(1, "MERGED");
      await harness.value.refreshAfterCurrent("/tmp/repo");
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
        "updated",
        "updated",
      ]);
      expect(harness.value.prData.get(key("/tmp/repo", "feature"))?.state).toBe(
        "MERGED",
      );
    } finally {
      harness.unmount();
    }
  });

  test.each(["success", "failure"])(
    "controller refresh after submission %s waits for an older poll before fetching current facts",
    async (outcome) => {
      history = [rawPr(1)];
      const harness = await renderHook([repo("/tmp/repo", ["feature"])]);
      let release!: () => void;
      try {
        await harness.waitForIdle();
        const pr = harness.value.prData.get(key("/tmp/repo", "feature"));
        if (!pr) throw new Error("Missing associated PR");
        const confirmed: MergeSnapshot = {
          pr: {
            ...pr,
            id: "PR-1",
            isDraft: false,
            reviewDecision: "APPROVED",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
          },
          queueRequired: false,
          methods: ["SQUASH"],
          configurationError: null,
        };
        const refreshAfterCurrent = vi.fn((path: string) =>
          harness.value.refreshAfterCurrent(path),
        );
        const reportError = vi.fn();
        const controller = createPrActionsController({
          getMode: () => Mode.Navigate,
          setMode: vi.fn(),
          showActionError: reportError,
          fetchSnapshot: async () => confirmed,
          submitMerge: async () => {
            if (outcome === "failure") throw new Error("merge failed");
            return "merged";
          },
          refresh: (path) => harness.value.refresh(path),
          refreshAfterCurrent,
          setExplicit: (path, branch, value) =>
            harness.value.setExplicit(path, branch, value),
          clearExplicit: (path, branch) =>
            harness.value.clearExplicit(path, branch),
          openInBrowser: vi.fn(),
        });
        controller.open({
          kind: "pr",
          repoPath: "/tmp/repo",
          branch: "feature",
          pr: confirmed.pr,
          candidates: [],
          explicit: false,
        });
        await harness.waitFor(() =>
          expect(controller.getSnapshot().menu).toMatchObject({
            mergeCheck: { status: "ready" },
          }),
        );
        controller.choose("merge");
        await harness.waitFor(() =>
          expect(controller.getSnapshot().menu?.screen).toBe("confirm"),
        );

        // This poll captured the old facts before submission and settles afterwards.
        const older = [...history];
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        list.mockImplementationOnce(() =>
          Effect.promise(async () => {
            await gate;
            return older;
          }),
        );
        vi.advanceTimersByTime(120_000);
        await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
        history = [
          rawPr(
            1,
            outcome === "success" ? "MERGED" : "OPEN",
            "feature",
            "fork/repo",
            "after-submission",
          ),
        ];
        controller.choose("confirm");
        await harness.waitFor(() =>
          expect(refreshAfterCurrent).toHaveBeenCalledExactlyOnceWith(
            "/tmp/repo",
          ),
        );
        await harness.flush();
        expect(list).toHaveBeenCalledTimes(2);
        expect(pendingEffects.size).toBeGreaterThan(0);

        release();
        await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
        await harness.waitForIdle();
        const current = harness.value.prData.get(key("/tmp/repo", "feature"));
        expect(current?.headOid).toBe("after-submission");
        expect(current?.state).toBe(outcome === "success" ? "MERGED" : "OPEN");
        expect(list.mock.calls.map((call) => call[1])).toEqual([
          "all",
          "updated",
          "updated",
        ]);
        if (outcome === "failure")
          expect(reportError).toHaveBeenCalledWith("merge failed");
      } finally {
        release?.();
        harness.unmount();
      }
    },
  );

  test("an expired base repository resolution detects changes and triggers complete discovery", async () => {
    const harness = await renderHook([repo()]);
    try {
      await harness.waitForIdle();
      base = "new/repo";
      vi.setSystemTime(Date.now() + 600_000);
      await poll(harness);
      expect(list.mock.calls.map((call) => call.slice(1, 3))).toEqual([
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
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      const manual = harness.value.refresh();
      explicitCache.set(key("/tmp/repo", "second"), {
        baseRepository: "base/repo",
        number: 2,
      });
      history = [rawPr(2, "MERGED", "second")];
      harness.rerender([repo("/tmp/repo", ["feature", "second"])]);
      await harness.flush();
      holdList = null;
      release();
      await manual;
      await harness.waitForIdle();
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
      await harness.waitForIdle();
      let release!: () => void;
      holdList = new Promise((resolve) => {
        release = resolve;
      });
      const manual = harness.value.refresh();
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      explicitCache.set(key("/tmp/repo", "second"), {
        baseRepository: "base/repo",
        number: 2,
      });
      history = [rawPr(2, "MERGED", "second")];
      harness.rerender([repo("/tmp/repo", ["feature", "second"])]);
      await harness.flush();
      holdList = null;
      release();
      await manual;
      await harness.waitForIdle();
      expect(explicitCache.get(key("/tmp/repo", "second"))?.number).toBe(2);
      expect(
        harness.value.associations.get(key("/tmp/repo", "second")),
      ).toMatchObject({ explicit: true, pr: { number: 2 } });
    } finally {
      harness.unmount();
    }
  });

  test("worktree changes share completed discovery instead of cancelling and restarting it", async () => {
    let release!: () => void;
    holdList = new Promise((resolve) => {
      release = resolve;
    });
    const harness = await renderHook([repo()]);
    try {
      await harness.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      expect(list).toHaveBeenCalledTimes(1);
      harness.rerender([repo("/tmp/repo", ["feature"])]);
      await harness.flush();
      expect(list).toHaveBeenCalledTimes(1);
      holdList = null;
      release();
      await harness.waitForIdle();
      expect(list.mock.calls.map((call) => call[1])).toEqual(["all"]);
      await poll(harness);
      expect(list.mock.calls.map((call) => call[1])).toEqual([
        "all",
        "updated",
      ]);
      expect(harness.value.errors.size).toBe(0);
      expect(harness.value.refreshingProjects.size).toBe(0);
    } finally {
      harness.unmount();
    }
  });
});

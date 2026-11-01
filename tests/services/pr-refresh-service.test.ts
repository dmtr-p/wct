import { Database } from "bun:sqlite";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scheduler, Scope } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { commandError, type WctError } from "../../src/errors";
import { runMigrations } from "../../src/services/db";
import { RegistrationId } from "../../src/services/identities";
import {
  livePrCacheService,
  type PrCacheServiceApi,
  sqlGetWorkspace,
  sqlSetWorkspace,
} from "../../src/services/pr-cache-service";
import {
  type PrRefreshRepository,
  PrRefreshService,
} from "../../src/services/pr-refresh-service";
import { wctTestLayer } from "../helpers/effect-vitest";

const repo: PrRefreshRepository = {
  id: RegistrationId("one"),
  repoPath: "/repo",
  worktrees: [],
};

function fixture(
  fail = false,
  options: {
    waitForStart?: boolean;
    stopping?: Deferred.Deferred<void>;
    cleanup?: Deferred.Deferred<void>;
    resolveBaseRepo?: () => Effect.Effect<string, WctError>;
    prCache?: Partial<PrCacheServiceApi>;
    repository?: PrRefreshRepository;
    discoveryPrs?: unknown[];
  } = {},
) {
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    let scans = 0;
    let resolutions = 0;
    const scanModes: string[] = [];
    let publications = 0;
    let workspacePublications = 0;
    const openPublications: number[][] = [];
    const errors = new Map<string, string>();
    const layer = wctTestLayer({
      github: {
        isGhInstalled: Effect.succeed(true),
        resolvePr: () => Effect.die("unused"),
        addForkRemote: () => Effect.void,
        fetchBranch: () => Effect.void,
        resolveBaseRepo: () =>
          Effect.suspend(() => {
            resolutions++;
            return options.resolveBaseRepo?.() ?? Effect.succeed("owner/repo");
          }),
        listRawPrs: (_cwd, mode) =>
          Effect.gen(function* () {
            scans++;
            scanModes.push(mode);
            if (scans === 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    if (options.stopping)
                      yield* Deferred.succeed(options.stopping, undefined);
                    if (options.cleanup) yield* Deferred.await(options.cleanup);
                    yield* Deferred.succeed(stopped, undefined);
                  }),
                ),
              );
            }
            if (fail)
              return yield* commandError("pr_error", "discovery failed");
            return options.discoveryPrs ?? [];
          }),
        getRawPrs: () => Effect.succeed([]),
        findRemoteForRepo: () => Effect.succeed(null),
      },
      prCache: {
        ...livePrCacheService,
        withWriteBatch: (writes) => writes,
        getDiscovery: () => Effect.succeed(null),
        getWorkspaceInputs: () => Effect.succeed([]),
        setDiscovery: () => Effect.succeed(true),
        setOpenPrs: () => Effect.void,
        pruneWorkspaces: () => Effect.void,
        ...options.prCache,
      },
    });
    const service = yield* PrRefreshService.pipe(Effect.provide(layer));
    const openSession = () =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(yield* Effect.scope);
        const session = yield* service
          .openSession({
            associations: () => {
              workspacePublications++;
              publications++;
            },
            openPrs: (update) => {
              publications++;
              openPublications.push(
                [...update(new Map()).values()].flat().map((pr) => pr.number),
              );
            },
            refreshing: () => {},
            errors: (update) => {
              const next = update(errors);
              errors.clear();
              for (const [key, value] of next) errors.set(key, value);
            },
          })
          .pipe(Scope.provide(scope));
        return { session, close: Scope.close(scope, Exit.void) };
      });
    const { session, close } = yield* openSession();
    const initial = yield* Effect.forkChild(
      session.updateRepositories([options.repository ?? repo]),
      {
        startImmediately: true,
      },
    );
    if (options.waitForStart !== false) yield* Deferred.await(started);
    return {
      session,
      close,
      openSession,
      initial,
      started,
      release,
      stopped,
      errors,
      scans: () => scans,
      resolutions: () => resolutions,
      scanModes,
      publications: () => publications,
      workspacePublications: () => workspacePublications,
      openPublications,
    };
  });
}

it.effect(
  "refresh replaces corrupt Workspace caches without blocking healthy branches",
  () =>
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const db = new Database(":memory:");
          runMigrations(db);
          return db;
        }),
        (db) => Effect.sync(() => db.close()),
      );
      const branches = ["broken", "healthy"];
      db.run("INSERT INTO workspace_pr_cache VALUES (?, ?, ?, ?, ?)", [
        repo.repoPath,
        "broken",
        "null",
        123,
        "offline",
      ]);
      sqlSetWorkspace(db, repo.repoPath, "healthy", {
        pr: null,
        candidates: [],
        newerOpenPr: null,
        fetchedAt: 123,
        lastError: null,
      });
      const f = yield* fixture(false, {
        repository: {
          ...repo,
          worktrees: branches.map((branch) => ({
            branch,
            path: `/missing-wct-cache-fixture/${branch}`,
            isMainWorktree: false,
          })),
        },
        discoveryPrs: branches.map((branch, index) => ({
          number: index + 1,
          title: branch,
          state: "MERGED",
          headRefName: branch,
          updatedAt: "2026-10-15T00:00:00Z",
        })),
        prCache: {
          getWorkspaceInputs: (path, requested) =>
            Effect.sync(() =>
              requested.map((branch) => ({
                branch,
                explicit: null,
                cached: sqlGetWorkspace(db, path, branch),
              })),
            ),
          setWorkspace: (path, branch, entry) =>
            Effect.sync(() => sqlSetWorkspace(db, path, branch, entry)),
        },
      });
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(f.initial);
      expect(f.errors.size).toBe(0);
      for (const branch of branches) {
        expect(sqlGetWorkspace(db, repo.repoPath, branch)).toMatchObject({
          candidates: [{ title: branch }],
          lastError: null,
        });
      }
      yield* f.session.refresh("manual");
      expect(f.errors.size).toBe(0);
      expect(f.scans()).toBe(2);
    }),
);

it.effect(
  "manual requests run behind failed automatic discovery and share a failed manual attempt",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const first = yield* Effect.forkChild(f.session.refresh("manual"), {
        startImmediately: true,
      });
      const second = yield* Effect.forkChild(f.session.refresh("manual"), {
        startImmediately: true,
      });
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(f.scans()).toBe(2);
      expect(f.errors.get("/repo")).toContain("discovery failed");
    }),
);

it.effect(
  "cancelling a waiter preserves discovery and does not start its queued refresh",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const waiter = yield* Effect.forkChild(f.session.refresh("manual"), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(waiter);
      expect(yield* Deferred.isDone(f.stopped)).toBe(false);
      yield* Deferred.succeed(f.release, undefined);
      yield* f.session.refresh("poll");
      expect(f.scans()).toBe(1);
      expect(f.publications()).toBeGreaterThan(0);
    }),
);

it.effect("worktree metadata changes reuse repository discovery", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.forkChild(
      f.session.updateRepositories([{ ...repo, error: "local scan failed" }]),
      { startImmediately: true },
    );
    expect(yield* Deferred.isDone(f.stopped)).toBe(false);
    yield* Deferred.succeed(f.release, undefined);
    yield* f.session.refresh("poll");
    expect(f.scans()).toBe(1);
  }),
);

it.effect.each(["discovery", "open list", "workspace pruning"] as const)(
  "a failed %s write retains discovery and retries storage without discovery backoff",
  (stage) =>
    Effect.gen(function* () {
      let failing = true;
      let writes = 0;
      const write = Effect.suspend(() => {
        writes++;
        return failing ? Effect.die(new Error("storage failed")) : Effect.void;
      });
      const prCache: Partial<PrCacheServiceApi> =
        stage === "discovery"
          ? { setDiscovery: () => write.pipe(Effect.as(true)) }
          : stage === "open list"
            ? { setOpenPrs: () => write }
            : { pruneWorkspaces: () => write };
      const f = yield* fixture(false, { prCache });
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(f.initial);
      expect(f.errors.get(repo.repoPath)).toContain("storage failed");
      expect(writes).toBe(1);
      failing = false;
      yield* f.session.refresh("poll");
      expect(writes).toBe(2);
      expect(f.errors.size).toBe(0);
      expect(f.scans()).toBe(1);
      yield* TestClock.adjust(30_000);
      yield* f.session.refresh("poll");
      expect(f.scanModes).toEqual(["all", "updated"]);
      expect(f.errors.size).toBe(0);
    }),
);

it.effect(
  "replacement registration interrupts obsolete discovery and starts new work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.session.updateRepositories([
        { ...repo, id: RegistrationId("two") },
      ]);
      yield* f.session.refresh("poll");
      expect(yield* Deferred.isDone(f.stopped)).toBe(true);
      expect(f.scans()).toBe(2);
    }),
);

it.effect(
  "completing the acquisition scope releases the session automatically",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.scoped(fixture());
      yield* Fiber.join(f.initial);
      expect(yield* Deferred.isDone(f.stopped)).toBe(true);
      expect(f.publications()).toBe(0);
      yield* f.session.refresh("manual");
      expect(f.scans()).toBe(1);
    }),
);

it.effect(
  "interrupting the session owner releases discovery and external waiters",
  () =>
    Effect.gen(function* () {
      const ready =
        yield* Deferred.make<Effect.Success<ReturnType<typeof fixture>>>();
      const owner = yield* Effect.forkChild(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* Deferred.succeed(ready, f);
          return yield* Effect.never;
        }).pipe(Effect.scoped),
      );
      const f = yield* Deferred.await(ready);
      const waiter = yield* Effect.forkChild(f.session.refresh("manual"), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(owner);
      yield* Fiber.join(waiter);
      expect(yield* Deferred.isDone(f.stopped)).toBe(true);
      expect(f.publications()).toBe(0);
      expect(f.scans()).toBe(1);
    }),
);

it.effect(
  "closing a session interrupts owned discovery without closing another session",
  () =>
    Effect.gen(function* () {
      const first = yield* fixture();
      const second = yield* fixture();
      yield* first.close;
      expect(yield* Deferred.isDone(first.stopped)).toBe(true);
      expect(first.publications()).toBe(0);
      expect(yield* Deferred.isDone(second.stopped)).toBe(false);
      yield* Deferred.succeed(second.release, undefined);
      yield* second.session.refresh("poll");
      expect(second.publications()).toBeGreaterThan(0);
    }),
);

it.effect("closing before task startup settles every external waiter", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false, { waitForStart: false });
    const first = yield* Effect.forkChild(f.session.refresh("manual"), {
      startImmediately: true,
    });
    const second = yield* Effect.forkChild(f.session.refresh("manual"), {
      startImmediately: true,
    });
    expect(f.scans()).toBe(0);
    yield* f.close;
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(f.scans()).toBe(0);
    expect(f.publications()).toBe(0);
  }),
);

it.effect("overlapping replacements cannot erase a newer registration", () =>
  Effect.gen(function* () {
    const stopping = yield* Deferred.make<void>();
    const cleanup = yield* Deferred.make<void>();
    const f = yield* fixture(false, { stopping, cleanup });
    const older = yield* Effect.forkChild(
      f.session.updateRepositories([{ ...repo, id: RegistrationId("two") }]),
      { startImmediately: true },
    );
    yield* Deferred.await(stopping);
    const newer = yield* Effect.forkChild(
      f.session.updateRepositories([{ ...repo, id: RegistrationId("three") }]),
      { startImmediately: true },
    );
    yield* Deferred.succeed(cleanup, undefined);
    yield* Fiber.join(older);
    yield* Fiber.join(newer);
    const scans = f.scans();
    yield* f.session.updateRepositories([
      { ...repo, id: RegistrationId("three") },
    ]);
    yield* f.session.refresh("poll");
    expect(f.scans()).toBe(scans);
    expect(f.errors.size).toBe(0);
  }),
);

it.effect.each([3, 4, 6])(
  "concurrent automatic callers reserve only one discovery flight (budget %i)",
  (budget) =>
    Effect.gen(function* () {
      const f = yield* fixture(false, { waitForStart: false });
      const callers = yield* Effect.forEach(Array.from({ length: 16 }), () =>
        Effect.forkChild(f.session.refresh("poll")),
      );
      yield* Deferred.await(f.started);
      yield* Deferred.succeed(f.release, undefined);
      yield* Effect.forEach(callers, (fiber) => Fiber.join(fiber), {
        concurrency: "unbounded",
      });
      expect(f.scans()).toBe(1);
    }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget)),
);

it.effect("base resolution expires ten minutes after success", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Deferred.succeed(f.release, undefined);
    yield* Fiber.join(f.initial);
    yield* f.session.refresh("action");
    expect(f.resolutions()).toBe(1);
    yield* TestClock.adjust(599_999);
    yield* f.session.refresh("action");
    expect(f.resolutions()).toBe(1);
    yield* TestClock.adjust(1);
    yield* f.session.refresh("action");
    expect(f.resolutions()).toBe(2);
  }),
);

it.effect("manual bypass resolves once for concurrent manual waiters", () =>
  Effect.gen(function* () {
    const resolving = yield* Deferred.make<void>();
    const releaseBase = yield* Deferred.make<void>();
    let calls = 0;
    const f = yield* fixture(false, {
      resolveBaseRepo: () =>
        Effect.gen(function* () {
          if (++calls === 2) {
            yield* Deferred.succeed(resolving, undefined);
            yield* Deferred.await(releaseBase);
          }
          return "owner/repo";
        }),
    });
    yield* Deferred.succeed(f.release, undefined);
    yield* Fiber.join(f.initial);
    const first = yield* Effect.forkChild(f.session.refresh("manual"), {
      startImmediately: true,
    });
    yield* Deferred.await(resolving);
    const second = yield* Effect.forkChild(f.session.refresh("manual"), {
      startImmediately: true,
    });
    yield* Deferred.succeed(releaseBase, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(f.resolutions()).toBe(2);
    yield* f.session.refresh("action");
    expect(f.resolutions()).toBe(2);
    yield* f.session.refresh("manual");
    expect(f.resolutions()).toBe(3);
  }),
);

it.effect(
  "replacement interrupts an obsolete base lookup and resolves anew",
  () =>
    Effect.gen(function* () {
      const resolving = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      let calls = 0;
      const f = yield* fixture(false, {
        waitForStart: false,
        resolveBaseRepo: () =>
          Effect.gen(function* () {
            if (++calls === 1) {
              yield* Deferred.succeed(resolving, undefined);
              return yield* Effect.never.pipe(
                Effect.ensuring(Deferred.succeed(interrupted, undefined)),
              );
            }
            return "owner/repo";
          }),
      });
      yield* Deferred.await(resolving);
      yield* Deferred.succeed(f.release, undefined);
      yield* f.session.updateRepositories([
        { ...repo, id: RegistrationId("two") },
      ]);
      yield* Deferred.await(interrupted);
      yield* Fiber.join(f.initial);
      expect(f.resolutions()).toBe(2);
      expect(f.scans()).toBe(1);
      yield* f.session.updateRepositories([repo]);
      expect(f.resolutions()).toBe(3);
    }),
);

it.effect.each(["action", "manual"] as const)(
  "failed base resolution is not cached for %s retries",
  (kind) =>
    Effect.gen(function* () {
      let failing = true;
      const f = yield* fixture(false, {
        waitForStart: false,
        resolveBaseRepo: () =>
          failing
            ? commandError("pr_error", "resolution failed")
            : Effect.succeed("owner/repo"),
      });
      yield* Fiber.join(f.initial);
      expect(f.resolutions()).toBe(1);
      expect(f.errors.get(repo.repoPath)).toContain("resolution failed");
      yield* f.session.refresh("poll");
      expect(f.resolutions()).toBe(1);
      yield* f.session.refresh(kind);
      expect(f.resolutions()).toBe(2);
      failing = false;
      yield* Deferred.succeed(f.release, undefined);
      yield* f.session.refresh(kind);
      expect(f.resolutions()).toBe(3);
      expect(f.scans()).toBe(1);
      expect(f.errors.size).toBe(0);
    }),
);

it.effect("automatic resolution retries when discovery backoff expires", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false, {
      waitForStart: false,
      resolveBaseRepo: () => commandError("pr_error", "resolution failed"),
    });
    yield* Fiber.join(f.initial);
    yield* TestClock.adjust(599_999);
    yield* f.session.refresh("poll");
    expect(f.resolutions()).toBe(1);
    yield* TestClock.adjust(1);
    yield* f.session.refresh("poll");
    expect(f.resolutions()).toBe(2);
  }),
);

it.effect(
  "registration replacement and removal invalidate base resolution",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(f.initial);
      yield* f.session.updateRepositories([
        { ...repo, id: RegistrationId("two") },
      ]);
      expect(f.resolutions()).toBe(2);
      yield* f.session.updateRepositories([repo]);
      expect(f.resolutions()).toBe(3);
      yield* f.session.updateRepositories([]);
      yield* f.session.updateRepositories([repo]);
      expect(f.resolutions()).toBe(4);
    }),
);

it.effect(
  "changed base repository starts complete discovery after expiry",
  () =>
    Effect.gen(function* () {
      let base = "owner/repo";
      const f = yield* fixture(false, {
        resolveBaseRepo: () => Effect.sync(() => base),
      });
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(f.initial);
      yield* f.session.refresh("action");
      base = "owner/replacement";
      yield* TestClock.adjust("10 minutes");
      yield* f.session.refresh("action");
      expect(f.scanModes).toEqual(["all", "updated", "all"]);
    }),
);

it.effect("sessions share compatible in-progress base resolutions", () =>
  Effect.gen(function* () {
    const resolving = yield* Deferred.make<void>();
    const releaseBase = yield* Deferred.make<void>();
    const f = yield* fixture(false, {
      waitForStart: false,
      resolveBaseRepo: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(resolving, undefined);
          yield* Deferred.await(releaseBase);
          return "owner/repo";
        }),
    });
    yield* Deferred.await(resolving);
    const second = yield* f.openSession();
    const updating = yield* Effect.forkChild(
      second.session.updateRepositories([repo]),
      {
        startImmediately: true,
      },
    );
    yield* Effect.yieldNow;
    yield* Deferred.succeed(f.release, undefined);
    yield* Deferred.succeed(releaseBase, undefined);
    yield* Fiber.join(f.initial);
    yield* Fiber.join(updating);
    expect(f.resolutions()).toBe(1);
    yield* second.session.refresh("action");
    expect(f.resolutions()).toBe(1);
  }),
);

it.effect("base resolution freshness starts when the lookup completes", () =>
  Effect.gen(function* () {
    const resolving = yield* Deferred.make<void>();
    const releaseBase = yield* Deferred.make<void>();
    const f = yield* fixture(false, {
      waitForStart: false,
      resolveBaseRepo: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(resolving, undefined);
          yield* Deferred.await(releaseBase);
          return "owner/repo";
        }),
    });
    yield* Deferred.await(resolving);
    yield* TestClock.adjust("5 minutes");
    yield* Deferred.succeed(f.release, undefined);
    yield* Deferred.succeed(releaseBase, undefined);
    yield* Fiber.join(f.initial);
    yield* TestClock.adjust("9 minutes");
    yield* f.session.refresh("action");
    expect(f.resolutions()).toBe(1);
    yield* TestClock.adjust("1 minute");
    yield* f.session.refresh("action");
    expect(f.resolutions()).toBe(2);
  }),
);

it.effect("independent services own independent base resolution caches", () =>
  Effect.gen(function* () {
    const first = yield* fixture();
    const second = yield* fixture();
    yield* Deferred.succeed(first.release, undefined);
    yield* Deferred.succeed(second.release, undefined);
    yield* Fiber.join(first.initial);
    yield* Fiber.join(second.initial);
    expect(first.resolutions()).toBe(1);
    expect(second.resolutions()).toBe(1);
  }),
);

it.effect(
  "a timed-out base lookup settles the owned flight and permits a queued manual retry",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      let attempts = 0;
      const f = yield* fixture(false, {
        waitForStart: false,
        resolveBaseRepo: () =>
          Effect.suspend(() =>
            ++attempts === 1
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(stopped, undefined)),
                  Effect.timeout("2 minutes"),
                  Effect.mapError((error) =>
                    commandError("pr_error", error.message, error),
                  ),
                )
              : Effect.succeed("owner/repo"),
          ),
      });
      yield* Deferred.await(started);
      const cancelled = yield* Effect.forkChild(f.session.refresh("manual"), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(cancelled);
      expect(yield* Deferred.isDone(stopped)).toBe(false);
      const manual = yield* Effect.forkChild(f.session.refresh("manual"), {
        startImmediately: true,
      });
      yield* Deferred.succeed(f.release, undefined);
      yield* TestClock.adjust("2 minutes");
      yield* Fiber.join(f.initial);
      yield* Fiber.join(manual);
      expect(yield* Deferred.isDone(stopped)).toBe(true);
      expect(f.resolutions()).toBe(2);
      expect(f.scans()).toBe(1);
      expect(f.errors.size).toBe(0);
    }),
);

it.effect(
  "one failed Workspace cache write does not discard healthy siblings or publication",
  () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const f = yield* fixture(false, {
        repository: {
          ...repo,
          worktrees: ["before", "broken", "after"].map((branch) => ({
            branch,
            path: "/missing-cache-batch-fixture/" + branch,
            isMainWorktree: false,
          })),
        },
        prCache: {
          setWorkspace: (_path, branch) =>
            Effect.suspend(() => {
              writes.push(branch);
              return branch === "broken"
                ? commandError("pr_cache_error", "broken Workspace write")
                : Effect.void;
            }),
        },
      });
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(f.initial);
      expect(writes).toEqual(["before", "broken", "after"]);
      expect(f.workspacePublications()).toBe(1);
      expect(f.errors.get(repo.repoPath)).toContain("broken Workspace write");
      expect(f.scans()).toBe(1);
    }),
);

it.effect(
  "batch acquisition failure still publishes fetched PRs and retries without discovery backoff",
  () =>
    Effect.gen(function* () {
      let failing = true;
      const f = yield* fixture(false, {
        discoveryPrs: [
          {
            number: 1,
            title: "Open PR",
            state: "OPEN",
            headRefName: "feature",
            updatedAt: "2026-10-15T00:00:00Z",
          },
        ],
        prCache: {
          withWriteBatch: (writes) =>
            failing
              ? commandError("pr_cache_error", "batch acquisition failed")
              : writes,
        },
      });
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(f.initial);
      expect(f.openPublications).toEqual([[1], [1]]);
      expect(f.workspacePublications()).toBe(1);
      expect(f.errors.get(repo.repoPath)).toContain("batch acquisition failed");
      failing = false;
      yield* f.session.refresh("poll");
      expect(f.errors.size).toBe(0);
      expect(f.scans()).toBe(1);
    }),
);

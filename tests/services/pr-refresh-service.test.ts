import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Scheduler } from "effect";
import { expect } from "vitest";
import { commandError } from "../../src/errors";
import { livePrCacheService } from "../../src/services/pr-cache-service";
import {
  type PrRefreshRepository,
  PrRefreshService,
} from "../../src/services/pr-refresh-service";
import { wctTestLayer } from "../helpers/effect-vitest";

const repo: PrRefreshRepository = {
  id: "one",
  repoPath: "/repo",
  worktrees: [],
};

function fixture(
  fail = false,
  options: {
    waitForStart?: boolean;
    stopping?: Deferred.Deferred<void>;
    cleanup?: Deferred.Deferred<void>;
  } = {},
) {
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    let scans = 0;
    let publications = 0;
    const errors = new Map<string, string>();
    const layer = wctTestLayer({
      github: {
        isGhInstalled: Effect.succeed(true),
        resolvePr: () => Effect.die("unused"),
        addForkRemote: () => Effect.void,
        fetchBranch: () => Effect.void,
        resolveBaseRepo: () => Effect.succeed("owner/repo"),
        listRawPrs: () =>
          Effect.gen(function* () {
            scans++;
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
            return [];
          }),
        getRawPrs: () => Effect.succeed([]),
        findRemoteForRepo: () => Effect.succeed(null),
      },
      prCache: {
        ...livePrCacheService,
        getDiscovery: () => Effect.succeed(null),
        getWorkspaceInputs: () => Effect.succeed([]),
        setDiscovery: () => Effect.succeed(true),
        setOpenPrs: () => Effect.void,
        pruneWorkspaces: () => Effect.void,
      },
    });
    const session = yield* PrRefreshService.use((service) =>
      service.openSession({
        associations: () => {
          publications++;
        },
        openPrs: () => {
          publications++;
        },
        refreshing: () => {},
        errors: (update) => {
          const next = update(errors);
          errors.clear();
          for (const [key, value] of next) errors.set(key, value);
        },
      }),
    ).pipe(Effect.provide(layer));
    yield* Effect.addFinalizer(() => session.close);
    yield* Effect.forkChild(session.updateRepositories([repo]), {
      startImmediately: true,
    });
    if (options.waitForStart !== false) yield* Deferred.await(started);
    return {
      session,
      started,
      release,
      stopped,
      errors,
      scans: () => scans,
      publications: () => publications,
    };
  });
}

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

it.effect(
  "replacement registration interrupts obsolete discovery and starts new work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.session.updateRepositories([{ ...repo, id: "two" }]);
      yield* f.session.refresh("poll");
      expect(yield* Deferred.isDone(f.stopped)).toBe(true);
      expect(f.scans()).toBe(2);
    }),
);

it.effect(
  "closing a session interrupts owned discovery without closing another session",
  () =>
    Effect.gen(function* () {
      const first = yield* fixture();
      const second = yield* fixture();
      yield* first.session.close;
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
    yield* f.session.close;
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
      f.session.updateRepositories([{ ...repo, id: "two" }]),
      { startImmediately: true },
    );
    yield* Deferred.await(stopping);
    const newer = yield* Effect.forkChild(
      f.session.updateRepositories([{ ...repo, id: "three" }]),
      { startImmediately: true },
    );
    yield* Deferred.succeed(cleanup, undefined);
    yield* Fiber.join(older);
    yield* Fiber.join(newer);
    const scans = f.scans();
    yield* f.session.updateRepositories([{ ...repo, id: "three" }]);
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
      yield* Effect.forEach(callers, Fiber.join, { concurrency: "unbounded" });
      expect(f.scans()).toBe(1);
    }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget)),
);

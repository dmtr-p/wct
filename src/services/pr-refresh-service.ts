import type { BunServices } from "@effect/platform-bun";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Scope,
  Semaphore,
} from "effect";
import { bunServiceKeys } from "../effect/service-context";
import type { WctError } from "../errors";
import { GitHubService } from "./github-service";
import {
  PrCacheService,
  type PrCacheServiceApi,
  type PrDiscoverySnapshot,
  type WorkspacePrEntry,
} from "./pr-cache-service";
import { resolvePushDestination } from "./pr-discovery";
import type { OpenPrChoice, PrFacts } from "./pr-model";
import { refreshPrDiscovery, refreshWorkspacePrs } from "./pr-refresh";

export interface PrRefreshRepository {
  id: string;
  repoPath: string;
  error?: string;
  worktrees: readonly {
    branch: string;
    path: string;
    isMainWorktree: boolean;
  }[];
}
export type RefreshKind = "poll" | "manual" | "action";
type Update<A> = (update: (previous: A) => A) => void;
export interface PrRefreshObserver {
  associations: Update<Map<string, WorkspacePrEntry>>;
  openPrs: Update<Map<string, OpenPrChoice[]>>;
  errors: Update<Map<string, string>>;
  refreshing: Update<Set<string>>;
}
export interface PrRefreshSession {
  updateRepositories: (
    repos: readonly PrRefreshRepository[],
  ) => Effect.Effect<void>;
  refresh: (kind: RefreshKind, repoPath?: string) => Effect.Effect<void>;
  setExplicit: (
    path: string,
    branch: string,
    pr: PrFacts,
  ) => Effect.Effect<void, WctError>;
  clearExplicit: (
    path: string,
    branch: string,
  ) => Effect.Effect<void, WctError>;
  close: Effect.Effect<void>;
}
export interface PrRefreshServiceApi {
  openSession: (observer: PrRefreshObserver) => Effect.Effect<PrRefreshSession>;
}
export const PrRefreshService = Context.Service<PrRefreshServiceApi>(
  "wct/PrRefreshService",
);
const DISCOVERY_RETRY_DELAY = 600_000;
const CACHE_FRESH_WINDOW = 30_000;
const BASE_REPO_CACHE_WINDOW = 600_000;
function causeMessage<E>(cause: Cause.Cause<E>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
}
function worktreeSignature(repo: PrRefreshRepository) {
  return JSON.stringify([
    repo.id,
    repo.error,
    repo.worktrees.map((wt) => [wt.branch, wt.path, wt.isMainWorktree]),
  ]);
}
function workspaceIdentityKey(path: string, branch: string) {
  return `${path}\0${branch}`;
}
function openPrChoice(pr: PrFacts): OpenPrChoice {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    headRefName: pr.headRefName,
  };
}
interface RefreshFlight {
  kind: RefreshKind;
  fiber?: Fiber.Fiber<void>;
  done: Deferred.Deferred<void>;
  cancelled: boolean;
  history: boolean;
  discovered: boolean;
  succeeded: boolean;
  failed: boolean;
  registrationId: string;
  signature: string;
}
export const makePrRefreshService = Effect.gen(function* () {
  const context = Context.pick(
    GitHubService,
    PrCacheService,
    ...bunServiceKeys,
  )(
    yield* Effect.context<
      GitHubService | PrCacheServiceApi | BunServices.BunServices
    >(),
  );
  const openSession = (observer: PrRefreshObserver) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const transitions = yield* Semaphore.make(1);
      let closed = false;
      let repos: readonly PrRefreshRepository[] = [];
      const currentRepo = (path: string) =>
        repos.find((repo) => repo.repoPath === path);
      const observed = new Map<string, string>();
      const registrations = new Map<string, string>();
      const discovery = new Map<string, PrDiscoverySnapshot>();
      const persisted = new Map<string, PrDiscoverySnapshot>();
      const loaded = new Set<string>();
      const discoveryRetries = new Map<string, number>();
      const baseRepositories = new Map<
        string,
        { name: string; resolvedAt: number }
      >();
      const inFlight = new Map<string, RefreshFlight>();
      const setAssociations = observer.associations;
      const setOpenPrs = observer.openPrs;
      const setErrors = observer.errors;
      const setRefreshingProjects = observer.refreshing;
      const refreshOne = (
        repoPath: string,
        requested: RefreshKind,
      ): Effect.Effect<void> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            let shareDiscovery = false;
            let running = inFlight.get(repoPath);
            while (running) {
              yield* restore(Deferred.await(running.done));
              if (closed) return;
              const current = currentRepo(repoPath);
              if (!current) return;
              const sameRegistration = running.registrationId === current.id;
              if (
                sameRegistration &&
                running.failed &&
                (requested === "poll" ||
                  (requested === "manual" && running.kind === "manual"))
              )
                return;
              if (
                sameRegistration &&
                requested === "manual" &&
                running.history &&
                running.discovered
              )
                shareDiscovery = true;
              if (
                requested === "poll" &&
                sameRegistration &&
                running.succeeded &&
                running.signature === worktreeSignature(current)
              )
                return;
              running = inFlight.get(repoPath);
            }
            if (closed) return;
            const registrationId = currentRepo(repoPath)?.id;
            if (!registrationId) return;
            const done = Deferred.makeUnsafe<void>();
            const flight: RefreshFlight = {
              done,
              kind: requested,
              cancelled: false,
              history: false,
              discovered: false,
              succeeded: false,
              failed: false,
              registrationId,
              signature: "",
            };
            // No yielded primitive separates the slot check from reservation.
            inFlight.set(repoPath, flight);
            const active = () =>
              !closed &&
              !flight.cancelled &&
              currentRepo(repoPath)?.id === registrationId;
            let showingRefresh = false;
            const task = Effect.gen(function* () {
              if (!active()) return;
              let historyPending = false;
              let resolvingBase = false;
              let historyBase: string | undefined;
              let cacheError: string | null = null;
              const cacheWrite = <A, E, R>(
                effect: Effect.Effect<A, E, R>,
                fallback: A,
              ) =>
                effect.pipe(
                  Effect.catchCause((cause) => {
                    cacheError ??= causeMessage(cause);
                    return Effect.succeed(fallback);
                  }),
                );
              const work = Effect.gen(function* () {
                if (!loaded.has(repoPath)) {
                  const cached = yield* PrCacheService.use((s) =>
                    s.getDiscovery(repoPath),
                  );
                  if (!active()) return;
                  if (cached) {
                    discovery.set(repoPath, cached);
                    persisted.set(repoPath, cached);
                  }
                  loaded.add(repoPath);
                }
                // Backoff belongs to automatic discovery, not user actions or live data.
                if (
                  requested === "poll" &&
                  (yield* Clock.currentTimeMillis) <
                    (discoveryRetries.get(repoPath) ?? 0)
                )
                  return;
                let snapshot = discovery.get(repoPath) ?? null;
                const reuseFresh =
                  requested === "poll" &&
                  snapshot !== null &&
                  (yield* Clock.currentTimeMillis) - snapshot.fetchedAt <
                    CACHE_FRESH_WINDOW;
                if (!reuseFresh && !shareDiscovery) {
                  showingRefresh = true;
                  setRefreshingProjects((previous) =>
                    new Set(previous).add(repoPath),
                  );
                  const cachedBase = baseRepositories.get(repoPath);
                  let base: string;
                  if (
                    requested !== "manual" &&
                    cachedBase &&
                    (yield* Clock.currentTimeMillis) - cachedBase.resolvedAt <
                      BASE_REPO_CACHE_WINDOW
                  ) {
                    base = cachedBase.name;
                  } else {
                    resolvingBase = true;
                    base = yield* GitHubService.use((s) =>
                      s.resolveBaseRepo(repoPath),
                    );
                    resolvingBase = false;
                    if (!active()) return;
                    baseRepositories.set(repoPath, {
                      name: base,
                      resolvedAt: yield* Clock.currentTimeMillis,
                    });
                  }
                  const previous = requested === "manual" ? null : snapshot;
                  flight.history =
                    previous?.baseRepository.toLowerCase() !==
                    base.toLowerCase();
                  historyPending = flight.history;
                  historyBase = base;
                  const fetched = yield* refreshPrDiscovery(
                    repoPath,
                    base,
                    previous,
                  ).pipe(Effect.timeout("10 minutes"));
                  if (!active()) return;
                  snapshot = fetched;
                  discovery.set(repoPath, fetched);
                  discoveryRetries.delete(repoPath);
                  historyPending = false;
                  flight.discovered = true;
                }
                if (!snapshot || !active()) return;
                const openNumbers = new Set(snapshot.openNumbers);
                const open = snapshot.prs.filter(
                  (pr) => openNumbers.has(pr.number) && pr.state === "OPEN",
                );
                setOpenPrs((previous) =>
                  new Map(previous).set(repoPath, open.map(openPrChoice)),
                );
                let currentSnapshot: PrDiscoverySnapshot = snapshot;
                // Worktree changes reconcile against the completed scan without restarting it.
                while (active()) {
                  const repo = currentRepo(repoPath);
                  if (!repo) return;
                  const signature = worktreeSignature(repo);
                  const isCurrent = () => {
                    const latest = currentRepo(repoPath);
                    return (
                      active() &&
                      latest !== undefined &&
                      worktreeSignature(latest) === signature
                    );
                  };
                  const trees = repo.worktrees.filter(
                    (wt) => !wt.isMainWorktree,
                  );
                  const inputs = yield* PrCacheService.use((s) =>
                    s.getWorkspaceInputs(
                      repoPath,
                      trees.map((wt) => wt.branch),
                    ),
                  );
                  const byBranch = new Map(
                    inputs.map((input) => [input.branch, input]),
                  );
                  const workspaces = yield* Effect.forEach(
                    trees,
                    (wt) =>
                      Effect.map(
                        resolvePushDestination(wt.path, wt.branch),
                        (destination) => ({
                          branch: wt.branch,
                          destination,
                          explicit: byBranch.get(wt.branch)?.explicit ?? null,
                          cached: byBranch.get(wt.branch)?.cached ?? null,
                        }),
                      ),
                    { concurrency: 4 },
                  );
                  if (!active()) return;
                  const refreshed = yield* refreshWorkspacePrs(
                    repoPath,
                    currentSnapshot,
                    workspaces,
                    requested !== "poll",
                    reuseFresh,
                  );
                  if (!active()) return;
                  currentSnapshot = refreshed.snapshot;
                  discovery.set(repoPath, refreshed.snapshot);
                  const latest = currentRepo(repoPath);
                  if (!latest) return;
                  if (worktreeSignature(latest) !== signature) continue;
                  if (persisted.get(repoPath) !== refreshed.snapshot) {
                    const saved = yield* cacheWrite(
                      PrCacheService.use((s) =>
                        s.setDiscovery(
                          repoPath,
                          refreshed.snapshot,
                          persisted.get(repoPath),
                          registrationId,
                        ),
                      ),
                      null as boolean | null,
                    );
                    if (saved === false) {
                      discovery.delete(repoPath);
                      persisted.delete(repoPath);
                      loaded.delete(repoPath);
                      flight.cancelled = true;
                      return;
                    }
                    if (saved) persisted.set(repoPath, refreshed.snapshot);
                  }
                  if (!isCurrent()) continue;
                  const refreshedOpen = refreshed.snapshot.prs
                    .filter((pr) => pr.state === "OPEN")
                    .map(openPrChoice);
                  yield* cacheWrite(
                    PrCacheService.use((s) =>
                      s.setOpenPrs(repoPath, refreshedOpen, registrationId),
                    ),
                    undefined,
                  );
                  if (!isCurrent()) continue;
                  setOpenPrs((previous) =>
                    new Map(previous).set(repoPath, refreshedOpen),
                  );
                  const found = new Map(
                    [...refreshed.entries].map(([branch, entry]) => [
                      workspaceIdentityKey(repoPath, branch),
                      entry,
                    ]),
                  );
                  yield* Effect.forEach(
                    [...refreshed.entries],
                    ([branch, entry]) =>
                      cacheWrite(
                        PrCacheService.use((s) =>
                          s.setWorkspace(
                            repoPath,
                            branch,
                            entry,
                            registrationId,
                          ),
                        ),
                        undefined,
                      ),
                    { concurrency: "unbounded", discard: true },
                  );
                  if (!isCurrent()) continue;
                  if (!repo.error)
                    yield* cacheWrite(
                      PrCacheService.use((s) =>
                        s.pruneWorkspaces(
                          repoPath,
                          workspaces.map((wt) => wt.branch),
                          registrationId,
                        ),
                      ),
                      undefined,
                    );
                  if (!isCurrent()) continue;
                  setAssociations(
                    (previous) =>
                      new Map(
                        [...previous]
                          .filter(([key]) => !key.startsWith(`${repoPath}\0`))
                          .concat([...found]),
                      ),
                  );
                  const error =
                    cacheError ??
                    [...found.values()].find((entry) => entry.lastError)
                      ?.lastError;
                  setErrors((previous) => {
                    const next = new Map(previous);
                    if (error) next.set(repoPath, error);
                    else next.delete(repoPath);
                    return next;
                  });
                  flight.signature = signature;
                  flight.succeeded = true;
                  return;
                }
              });
              yield* work.pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    if (!active()) return;
                    flight.failed = true;
                    // A failed associated PR cannot invalidate a completed history scan.
                    if (
                      resolvingBase ||
                      (historyPending &&
                        discovery
                          .get(repoPath)
                          ?.baseRepository.toLowerCase() !==
                          historyBase?.toLowerCase())
                    )
                      discoveryRetries.set(
                        repoPath,
                        (yield* Clock.currentTimeMillis) +
                          DISCOVERY_RETRY_DELAY,
                      );
                    const message = causeMessage(cause);
                    setErrors((previous) =>
                      new Map(previous).set(repoPath, message),
                    );
                    yield* Effect.forEach(
                      currentRepo(repoPath)?.worktrees.filter(
                        (wt) => !wt.isMainWorktree,
                      ) ?? [],
                      (wt) =>
                        PrCacheService.use((s) =>
                          s.setWorkspaceError(
                            repoPath,
                            wt.branch,
                            message,
                            registrationId,
                          ),
                        ).pipe(Effect.ignoreCause),
                      { concurrency: "unbounded", discard: true },
                    );
                    if (!active()) return;
                    setAssociations(
                      (previous) =>
                        new Map(
                          [...previous].map(([key, entry]) =>
                            key.startsWith(`${repoPath}\0`)
                              ? [key, { ...entry, lastError: message }]
                              : [key, entry],
                          ),
                        ),
                    );
                  }),
                ),
              );
            }).pipe(Effect.provideContext(context));
            // Completion observers also run when cancellation precedes task startup.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                flight.fiber = yield* Effect.forkIn(task, scope);
                flight.fiber.addObserver(() => {
                  try {
                    if (inFlight.get(repoPath) === flight)
                      inFlight.delete(repoPath);
                    if (showingRefresh && !closed && !inFlight.has(repoPath)) {
                      setRefreshingProjects((previous) => {
                        const next = new Set(previous);
                        next.delete(repoPath);
                        return next;
                      });
                    }
                  } finally {
                    Deferred.doneUnsafe(flight.done, Effect.void);
                  }
                });
              }),
            );
            if (flight.cancelled && flight.fiber)
              yield* Fiber.interrupt(flight.fiber);
            yield* restore(Deferred.await(flight.done));
          }),
        );
      const refresh = (kind: RefreshKind, path?: string) =>
        Effect.suspend(() =>
          Effect.forEach(
            repos.filter(
              (repo) => path === undefined || repo.repoPath === path,
            ),
            (repo) => refreshOne(repo.repoPath, kind),
            { concurrency: "unbounded", discard: true },
          ),
        );
      const forget = (path: string) =>
        Effect.gen(function* () {
          const flight = inFlight.get(path);
          if (flight) {
            flight.cancelled = true;
          }
          observed.delete(path);
          registrations.delete(path);
          discovery.delete(path);
          persisted.delete(path);
          loaded.delete(path);
          discoveryRetries.delete(path);
          baseRepositories.delete(path);
          setRefreshingProjects((previous) => {
            const next = new Set(previous);
            next.delete(path);
            return next;
          });
          setErrors((previous) => {
            const next = new Map(previous);
            next.delete(path);
            return next;
          });
          if (flight?.fiber) yield* Fiber.interrupt(flight.fiber);
        });
      return {
        updateRepositories: (next) =>
          transitions
            .withPermits(1)(
              Effect.gen(function* () {
                if (closed) return [];
                repos = next;
                for (const [path, id] of registrations) {
                  if (
                    !next.some(
                      (repo) => repo.repoPath === path && repo.id === id,
                    )
                  )
                    yield* forget(path);
                }
                if (closed) return [];
                const pending: Fiber.Fiber<void>[] = [];
                for (const repo of next) {
                  const signature = worktreeSignature(repo);
                  if (observed.get(repo.repoPath) === signature) continue;
                  registrations.set(repo.repoPath, repo.id);
                  observed.set(repo.repoPath, signature);
                  pending.push(
                    yield* Effect.forkIn(
                      refreshOne(repo.repoPath, "poll"),
                      scope,
                    ),
                  );
                }
                return pending;
              }),
            )
            .pipe(
              Effect.flatMap((pending) =>
                Effect.forEach(pending, Fiber.await, { discard: true }),
              ),
            ),
        refresh,
        setExplicit: (path, branch, pr) =>
          PrCacheService.use((s) =>
            s.setExplicit(path, branch, {
              baseRepository: pr.baseRepository,
              number: pr.number,
            }),
          ).pipe(
            Effect.provideContext(context),
            Effect.andThen(() => refresh("action", path)),
          ),
        clearExplicit: (path, branch) =>
          PrCacheService.use((s) => s.clearExplicit(path, branch)).pipe(
            Effect.provideContext(context),
            Effect.andThen(() => refresh("action", path)),
          ),
        close: Effect.gen(function* () {
          closed = true;
          yield* Scope.close(scope, Exit.void);
        }),
      } satisfies PrRefreshSession;
    });
  return { openSession } satisfies PrRefreshServiceApi;
});

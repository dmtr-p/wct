import type { BunServices } from "@effect/platform-bun";
import {
  Cache,
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
  type RegistrationId,
  type WorkspaceIdentityKey,
  workspaceIdentityKey,
} from "./identities";
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
  id: RegistrationId;
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
  associations: Update<Map<WorkspaceIdentityKey, WorkspacePrEntry>>;
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
}
export interface PrRefreshServiceApi {
  openSession: (
    observer: PrRefreshObserver,
  ) => Effect.Effect<PrRefreshSession, never, Scope.Scope>;
}
export const PrRefreshService = Context.Service<PrRefreshServiceApi>(
  "wct/PrRefreshService",
);
const DISCOVERY_RETRY_DELAY = 600_000;
const CACHE_FRESH_WINDOW = 30_000;
const BASE_REPO_CACHE_WINDOW = 600_000;
function baseRepositoryKey(repoPath: string, registrationId: RegistrationId) {
  return `${repoPath}\0${registrationId}`;
}
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
  registrationId: RegistrationId;
  signature: string;
}

interface RefreshCacheState {
  discovery: Map<string, PrDiscoverySnapshot>;
  persisted: Map<string, PrDiscoverySnapshot>;
  loaded: Set<string>;
  discoveryRetries: Map<string, number>;
}
interface RefreshTask {
  repoPath: string;
  flight: RefreshFlight;
  active: () => boolean;
  showingRefresh: boolean;
  historyPending: boolean;
  resolvingBase: boolean;
  historyBase?: string;
  cacheError: string | null;
}
type CurrentRepository = (path: string) => PrRefreshRepository | undefined;
interface PreparedDiscovery {
  snapshot: PrDiscoverySnapshot;
  reuseFresh: boolean;
}

function writeRefreshCache<A, E, R>(
  task: RefreshTask,
  effect: Effect.Effect<A, E, R>,
  fallback: A,
) {
  return effect.pipe(
    Effect.catchCause((cause) => {
      task.cacheError ??= causeMessage(cause);
      return Effect.succeed(fallback);
    }),
  );
}

function prepareDiscovery(
  task: RefreshTask,
  state: RefreshCacheState,
  baseRepositories: Cache.Cache<string, string, WctError>,
  observer: PrRefreshObserver,
  shareDiscovery: boolean,
) {
  return Effect.gen(function* () {
    const { repoPath, flight, active } = task;
    const { kind: requested, registrationId } = flight;
    const { discovery, persisted, loaded, discoveryRetries } = state;
    if (!loaded.has(repoPath)) {
      const cached = yield* PrCacheService.use((s) => s.getDiscovery(repoPath));
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
      (yield* Clock.currentTimeMillis) < (discoveryRetries.get(repoPath) ?? 0)
    )
      return;
    let snapshot = discovery.get(repoPath) ?? null;
    const reuseFresh =
      requested === "poll" &&
      snapshot !== null &&
      (yield* Clock.currentTimeMillis) - snapshot.fetchedAt <
        CACHE_FRESH_WINDOW;
    if (!reuseFresh && !shareDiscovery) {
      task.showingRefresh = true;
      observer.refreshing((previous) => new Set(previous).add(repoPath));
      const baseKey = baseRepositoryKey(repoPath, registrationId);
      if (requested === "manual")
        yield* Cache.invalidate(baseRepositories, baseKey);
      task.resolvingBase = true;
      const base = yield* Cache.get(baseRepositories, baseKey);
      task.resolvingBase = false;
      if (!active()) return;
      const previous = requested === "manual" ? null : snapshot;
      flight.history =
        previous?.baseRepository.toLowerCase() !== base.toLowerCase();
      task.historyPending = flight.history;
      task.historyBase = base;
      const fetched = yield* refreshPrDiscovery(repoPath, base, previous).pipe(
        Effect.timeout("10 minutes"),
      );
      if (!active()) return;
      snapshot = fetched;
      discovery.set(repoPath, fetched);
      discoveryRetries.delete(repoPath);
      task.historyPending = false;
      flight.discovered = true;
    }
    if (!snapshot || !active()) return;
    return { snapshot, reuseFresh } satisfies PreparedDiscovery;
  });
}

function publishOpenPrs(
  observer: PrRefreshObserver,
  repoPath: string,
  choices: OpenPrChoice[],
) {
  observer.openPrs((previous) => new Map(previous).set(repoPath, choices));
}

function publishWorkspaceEntries(
  observer: PrRefreshObserver,
  repoPath: string,
  found: Map<WorkspaceIdentityKey, WorkspacePrEntry>,
  cacheError: string | null,
) {
  observer.associations(
    (previous) =>
      new Map(
        [...previous]
          .filter(
            ([key]) => !key.startsWith(workspaceIdentityKey(repoPath, "")),
          )
          .concat([...found]),
      ),
  );
  const error =
    cacheError ??
    [...found.values()].find((entry) => entry.lastError)?.lastError;
  observer.errors((previous) => {
    const next = new Map(previous);
    if (error) next.set(repoPath, error);
    else next.delete(repoPath);
    return next;
  });
}

function reconcileWorkspaces(
  task: RefreshTask,
  state: RefreshCacheState,
  currentRepo: CurrentRepository,
  prepared: PreparedDiscovery,
  observer: PrRefreshObserver,
) {
  return Effect.gen(function* () {
    const { repoPath, flight, active } = task;
    const { kind: requested, registrationId } = flight;
    const { discovery, persisted, loaded } = state;
    const { snapshot, reuseFresh } = prepared;
    if (!active()) return;
    const openNumbers = new Set(snapshot.openNumbers);
    const open = snapshot.prs.filter(
      (pr) => openNumbers.has(pr.number) && pr.state === "OPEN",
    );
    publishOpenPrs(observer, repoPath, open.map(openPrChoice));
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
      const trees = repo.worktrees;
      const inputs = yield* PrCacheService.use((s) =>
        s.getWorkspaceInputs(
          repoPath,
          trees.map((wt) => wt.branch),
        ),
      );
      const byBranch = new Map(inputs.map((input) => [input.branch, input]));
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
        const saved = yield* writeRefreshCache(
          task,
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
      yield* writeRefreshCache(
        task,
        PrCacheService.use((s) =>
          s.setOpenPrs(repoPath, refreshedOpen, registrationId),
        ),
        undefined,
      );
      if (!isCurrent()) continue;
      publishOpenPrs(observer, repoPath, refreshedOpen);
      const found = new Map(
        [...refreshed.entries].map(([branch, entry]) => [
          workspaceIdentityKey(repoPath, branch),
          entry,
        ]),
      );
      yield* Effect.forEach(
        [...refreshed.entries],
        ([branch, entry]) =>
          writeRefreshCache(
            task,
            PrCacheService.use((s) =>
              s.setWorkspace(repoPath, branch, entry, registrationId),
            ),
            undefined,
          ),
        { concurrency: "unbounded", discard: true },
      );
      if (!isCurrent()) continue;
      if (!repo.error)
        yield* writeRefreshCache(
          task,
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
      publishWorkspaceEntries(observer, repoPath, found, task.cacheError);
      flight.signature = signature;
      flight.succeeded = true;
      return;
    }
  });
}

function recoverRefreshFailure<E>(
  task: RefreshTask,
  state: RefreshCacheState,
  currentRepo: CurrentRepository,
  observer: PrRefreshObserver,
  cause: Cause.Cause<E>,
) {
  return Effect.gen(function* () {
    const { repoPath, flight, active } = task;
    const { registrationId } = flight;
    const { discovery, discoveryRetries } = state;
    if (!active()) return;
    flight.failed = true;
    // A failed associated PR cannot invalidate a completed history scan.
    if (
      task.resolvingBase ||
      (task.historyPending &&
        discovery.get(repoPath)?.baseRepository.toLowerCase() !==
          task.historyBase?.toLowerCase())
    )
      discoveryRetries.set(
        repoPath,
        (yield* Clock.currentTimeMillis) + DISCOVERY_RETRY_DELAY,
      );
    const message = causeMessage(cause);
    observer.errors((previous) => new Map(previous).set(repoPath, message));
    yield* Effect.forEach(
      currentRepo(repoPath)?.worktrees ?? [],
      (wt) =>
        PrCacheService.use((s) =>
          s.setWorkspaceError(repoPath, wt.branch, message, registrationId),
        ).pipe(Effect.ignoreCause),
      { concurrency: "unbounded", discard: true },
    );
    if (!active()) return;
    observer.associations(
      (previous) =>
        new Map(
          [...previous].map(([key, entry]) =>
            key.startsWith(workspaceIdentityKey(repoPath, ""))
              ? [key, { ...entry, lastError: message }]
              : [key, entry],
          ),
        ),
    );
  });
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
  const github = Context.get(context, GitHubService);
  const baseRepositories = yield* Cache.makeWith(
    // Filesystem paths cannot contain NUL, so the registration suffix is unambiguous.
    (key: string) => github.resolveBaseRepo(key.slice(0, key.indexOf("\0"))),
    {
      capacity: Number.POSITIVE_INFINITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? BASE_REPO_CACHE_WINDOW : 0),
    },
  );
  const openSession = (observer: PrRefreshObserver) =>
    Effect.gen(function* () {
      let closed = false;
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Effect.gen(function* () {
          closed = true;
          yield* Scope.close(scope, Exit.void);
        }),
      );
      const transitions = yield* Semaphore.make(1);
      let repos: readonly PrRefreshRepository[] = [];
      const currentRepo = (path: string) =>
        repos.find((repo) => repo.repoPath === path);
      const observed = new Map<string, string>();
      const registrations = new Map<string, RegistrationId>();
      const discovery = new Map<string, PrDiscoverySnapshot>();
      const persisted = new Map<string, PrDiscoverySnapshot>();
      const loaded = new Set<string>();
      const discoveryRetries = new Map<string, number>();
      const cacheState: RefreshCacheState = {
        discovery,
        persisted,
        loaded,
        discoveryRetries,
      };
      const inFlight = new Map<string, RefreshFlight>();
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
            const refreshTask: RefreshTask = {
              repoPath,
              flight,
              active,
              showingRefresh: false,
              historyPending: false,
              resolvingBase: false,
              cacheError: null,
            };
            const task = Effect.gen(function* () {
              if (!active()) return;
              const prepared = yield* prepareDiscovery(
                refreshTask,
                cacheState,
                baseRepositories,
                observer,
                shareDiscovery,
              );
              if (!prepared) return;
              yield* reconcileWorkspaces(
                refreshTask,
                cacheState,
                currentRepo,
                prepared,
                observer,
              );
            }).pipe(
              Effect.catchCause((cause) =>
                recoverRefreshFailure(
                  refreshTask,
                  cacheState,
                  currentRepo,
                  observer,
                  cause,
                ),
              ),
              Effect.provideContext(context),
            );
            // Completion observers also run when cancellation precedes task startup.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                flight.fiber = yield* Effect.forkIn(task, scope);
                flight.fiber.addObserver(() => {
                  try {
                    if (inFlight.get(repoPath) === flight)
                      inFlight.delete(repoPath);
                    if (
                      refreshTask.showingRefresh &&
                      !closed &&
                      !inFlight.has(repoPath)
                    ) {
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
          const registrationId = registrations.get(path);
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
          if (registrationId !== undefined)
            yield* Cache.invalidate(
              baseRepositories,
              baseRepositoryKey(path, registrationId),
            );
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
                Effect.forEach(pending, (fiber) => Fiber.await(fiber), {
                  discard: true,
                }),
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
      } satisfies PrRefreshSession;
    });
  return { openSession } satisfies PrRefreshServiceApi;
});

import { Effect } from "effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitHubService } from "../../services/github-service";
import {
  PrCacheService,
  type PrDiscoverySnapshot,
  type WorkspacePrEntry,
} from "../../services/pr-cache-service";
import { resolvePushDestination } from "../../services/pr-discovery";
import type { OpenPrChoice, PrFacts } from "../../services/pr-model";
import {
  refreshPrDiscovery,
  refreshWorkspacePrs,
} from "../../services/pr-refresh";
import { workspaceIdentityKey } from "../lifecycle";
import { tuiRuntime } from "../runtime";
import type { RepoInfo } from "./useRegistry";

const GITHUB_POLL_INTERVAL = 120_000;
const DISCOVERY_RETRY_DELAY = 600_000;
const CACHE_FRESH_WINDOW = 30_000;
const BASE_REPO_CACHE_WINDOW = 600_000;
type RefreshKind = "poll" | "manual" | "action";
interface RefreshFlight {
  kind: RefreshKind;
  promise: Promise<void>;
  controller: AbortController;
  history: boolean;
  discovered: boolean;
  succeeded: boolean;
  failed: boolean;
  registrationId: string;
  signature: string;
}
function worktreeSignature(repo: RepoInfo) {
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

function hydrate(repos: RepoInfo[]) {
  const associations = new Map<string, WorkspacePrEntry>();
  const openPrs = new Map<string, OpenPrChoice[]>();
  for (const repo of repos) {
    try {
      const open = tuiRuntime.runSync(
        PrCacheService.use((s) => s.getOpenPrs(repo.repoPath)),
      );
      if (open)
        openPrs.set(
          repo.repoPath,
          open.payload.filter((pr) => pr.state === "OPEN"),
        );
      for (const wt of repo.worktrees) {
        const cached = tuiRuntime.runSync(
          PrCacheService.use((s) => s.getWorkspace(repo.repoPath, wt.branch)),
        );
        if (cached)
          associations.set(
            workspaceIdentityKey(repo.repoPath, wt.branch),
            cached,
          );
      }
    } catch {
      /* cache errors leave unknown data */
    }
  }
  return { associations, openPrs };
}

export function useGitHub(repos: RepoInfo[]) {
  const [initial] = useState(() => hydrate(repos));
  const [associations, setAssociations] = useState(initial.associations);
  const [openPrs, setOpenPrs] = useState(initial.openPrs);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [refreshingProjects, setRefreshingProjects] = useState<Set<string>>(
    new Set(),
  );
  const reposRef = useRef(repos);
  reposRef.current = repos;
  const mounted = useRef(true);
  const repoSignature = JSON.stringify(
    repos.map((repo) => [repo.repoPath, worktreeSignature(repo)]),
  );
  const observed = useRef(new Map<string, string>());
  const registrations = useRef(new Map<string, string>());
  const discovery = useRef(new Map<string, PrDiscoverySnapshot>());
  const persisted = useRef(new Map<string, PrDiscoverySnapshot>());
  const loaded = useRef(new Set<string>());
  const discoveryRetries = useRef(new Map<string, number>());
  const baseRepositories = useRef(
    new Map<string, { name: string; resolvedAt: number }>(),
  );
  const inFlight = useRef(new Map<string, RefreshFlight>());
  const currentRepo = useCallback(
    (path: string) => reposRef.current.find((repo) => repo.repoPath === path),
    [],
  );

  useEffect(() => {
    const cached = hydrate(repos);
    setAssociations((previous) => {
      const next = new Map(previous);
      for (const [key, entry] of cached.associations)
        if (!next.has(key)) next.set(key, entry);
      return next;
    });
    setOpenPrs((previous) => {
      const next = new Map(previous);
      for (const [key, prs] of cached.openPrs)
        if (!next.has(key)) next.set(key, prs);
      return next;
    });
  }, [repos]);

  const refreshOne = useCallback(
    async (repoPath: string, kind: RefreshKind, signal?: AbortSignal) => {
      const requested = kind;
      let shareDiscovery = false;
      let running = inFlight.current.get(repoPath);
      while (running) {
        await running.promise;
        if (signal?.aborted || !mounted.current) return;
        const current = currentRepo(repoPath);
        if (!current) return;
        // A completed full discovery satisfies a concurrent manual request.
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
        running = inFlight.current.get(repoPath);
      }
      if (signal?.aborted || !mounted.current || !currentRepo(repoPath)) return;
      const registrationId = currentRepo(repoPath)?.id;
      if (!registrationId) return;
      const flight: RefreshFlight = {
        kind: requested,
        promise: Promise.resolve(),
        controller: new AbortController(),
        history: false,
        discovered: false,
        succeeded: false,
        failed: false,
        registrationId,
        signature: "",
      };
      inFlight.current.set(repoPath, flight);
      const active = () =>
        mounted.current &&
        !flight.controller.signal.aborted &&
        currentRepo(repoPath)?.id === registrationId;
      flight.promise = (async () => {
        let historyPending = false;
        let resolvingBase = false;
        let historyBase: string | undefined;
        let showingRefresh = false;
        let cacheError: string | null = null;
        const cacheWrite = async <A>(
          promise: Promise<A>,
          fallback: A,
        ): Promise<A> =>
          promise.catch((cause) => {
            cacheError ??=
              cause instanceof Error ? cause.message : String(cause);
            return fallback;
          });
        try {
          if (!loaded.current.has(repoPath)) {
            const cached = await tuiRuntime.runPromise(
              PrCacheService.use((s) => s.getDiscovery(repoPath)),
              { signal: flight.controller.signal },
            );
            if (!active()) return;
            if (cached) {
              discovery.current.set(repoPath, cached);
              persisted.current.set(repoPath, cached);
            }
            loaded.current.add(repoPath);
          }
          // Backoff belongs to automatic discovery, not user actions or live data.
          if (
            requested === "poll" &&
            Date.now() < (discoveryRetries.current.get(repoPath) ?? 0)
          )
            return;
          const opts = { signal: flight.controller.signal };
          let snapshot = discovery.current.get(repoPath) ?? null;
          const reuseFresh =
            requested === "poll" &&
            snapshot !== null &&
            Date.now() - snapshot.fetchedAt < CACHE_FRESH_WINDOW;
          if (!reuseFresh && !shareDiscovery) {
            showingRefresh = true;
            setRefreshingProjects((previous) =>
              new Set(previous).add(repoPath),
            );
            const cachedBase = baseRepositories.current.get(repoPath);
            let base: string;
            if (
              requested !== "manual" &&
              cachedBase &&
              Date.now() - cachedBase.resolvedAt < BASE_REPO_CACHE_WINDOW
            ) {
              base = cachedBase.name;
            } else {
              resolvingBase = true;
              base = await tuiRuntime.runPromise(
                GitHubService.use((s) => s.resolveBaseRepo(repoPath)),
                opts,
              );
              resolvingBase = false;
              if (!active()) return;
              baseRepositories.current.set(repoPath, {
                name: base,
                resolvedAt: Date.now(),
              });
            }
            const previous = requested === "manual" ? null : snapshot;
            flight.history =
              previous?.baseRepository.toLowerCase() !== base.toLowerCase();
            historyPending = flight.history;
            historyBase = base;
            const fetched = await tuiRuntime.runPromise(
              refreshPrDiscovery(repoPath, base, previous),
              opts,
            );
            if (!active()) return;
            snapshot = fetched;
            discovery.current.set(repoPath, fetched);
            discoveryRetries.current.delete(repoPath);
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
            const trees = repo.worktrees.filter((wt) => !wt.isMainWorktree);
            const inputs = await tuiRuntime.runPromise(
              PrCacheService.use((s) =>
                s.getWorkspaceInputs(
                  repoPath,
                  trees.map((wt) => wt.branch),
                ),
              ),
            );
            const byBranch = new Map(
              inputs.map((input) => [input.branch, input]),
            );
            const workspaces = await tuiRuntime.runPromise(
              Effect.forEach(
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
              ),
              opts,
            );
            if (!active()) return;
            const refreshed = await tuiRuntime.runPromise(
              refreshWorkspacePrs(
                repoPath,
                currentSnapshot,
                workspaces,
                requested !== "poll",
                reuseFresh,
              ),
              opts,
            );
            if (!active()) return;
            currentSnapshot = refreshed.snapshot;
            discovery.current.set(repoPath, refreshed.snapshot);
            const latest = currentRepo(repoPath);
            if (!latest) return;
            if (worktreeSignature(latest) !== signature) continue;
            if (persisted.current.get(repoPath) !== refreshed.snapshot) {
              const saved = await cacheWrite<boolean | null>(
                tuiRuntime.runPromise(
                  PrCacheService.use((s) =>
                    s.setDiscovery(
                      repoPath,
                      refreshed.snapshot,
                      persisted.current.get(repoPath),
                      registrationId,
                    ),
                  ),
                ),
                null,
              );
              if (saved === false) {
                discovery.current.delete(repoPath);
                persisted.current.delete(repoPath);
                loaded.current.delete(repoPath);
                flight.controller.abort();
                return;
              }
              if (saved) persisted.current.set(repoPath, refreshed.snapshot);
            }
            if (!isCurrent()) continue;
            const refreshedOpen = refreshed.snapshot.prs
              .filter((pr) => pr.state === "OPEN")
              .map(openPrChoice);
            await cacheWrite(
              tuiRuntime.runPromise(
                PrCacheService.use((s) =>
                  s.setOpenPrs(repoPath, refreshedOpen, registrationId),
                ),
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
            await Promise.all(
              [...refreshed.entries].map(([branch, entry]) =>
                cacheWrite(
                  tuiRuntime.runPromise(
                    PrCacheService.use((s) =>
                      s.setWorkspace(repoPath, branch, entry, registrationId),
                    ),
                  ),
                  undefined,
                ),
              ),
            );
            if (!isCurrent()) continue;
            if (!repo.error)
              await cacheWrite(
                tuiRuntime.runPromise(
                  PrCacheService.use((s) =>
                    s.pruneWorkspaces(
                      repoPath,
                      workspaces.map((wt) => wt.branch),
                      registrationId,
                    ),
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
              [...found.values()].find((entry) => entry.lastError)?.lastError;
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
        } catch (cause) {
          if (!active()) return;
          flight.failed = true;
          // A failed associated PR cannot invalidate a completed history scan.
          if (
            resolvingBase ||
            (historyPending &&
              discovery.current.get(repoPath)?.baseRepository.toLowerCase() !==
                historyBase?.toLowerCase())
          )
            discoveryRetries.current.set(
              repoPath,
              Date.now() + DISCOVERY_RETRY_DELAY,
            );
          const message =
            cause instanceof Error ? cause.message : String(cause);
          setErrors((previous) => new Map(previous).set(repoPath, message));
          for (const wt of currentRepo(repoPath)?.worktrees.filter(
            (wt) => !wt.isMainWorktree,
          ) ?? [])
            void tuiRuntime
              .runPromise(
                PrCacheService.use((s) =>
                  s.setWorkspaceError(
                    repoPath,
                    wt.branch,
                    message,
                    registrationId,
                  ),
                ),
              )
              .catch(() => {});
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
        } finally {
          if (inFlight.current.get(repoPath) === flight)
            inFlight.current.delete(repoPath);
          if (showingRefresh && mounted.current)
            setRefreshingProjects((previous) => {
              const next = new Set(previous);
              next.delete(repoPath);
              return next;
            });
        }
      })();
      return flight.promise;
    },
    [currentRepo],
  );

  const refreshTargets = useCallback(
    async (kind: RefreshKind, repoPath?: string, signal?: AbortSignal) => {
      const targets =
        repoPath === undefined
          ? reposRef.current
          : reposRef.current.filter((repo) => repo.repoPath === repoPath);
      await Promise.allSettled(
        targets.map((repo) => refreshOne(repo.repoPath, kind, signal)),
      );
    },
    [refreshOne],
  );
  const refresh = useCallback(
    (repoPath?: string, signal?: AbortSignal) =>
      refreshTargets("manual", repoPath, signal),
    [refreshTargets],
  );
  const refreshCurrent = useCallback(
    (repoPath?: string, signal?: AbortSignal) =>
      refreshTargets("poll", repoPath, signal),
    [refreshTargets],
  );
  const refreshAfterCurrent = useCallback(
    (repoPath: string) => refreshTargets("action", repoPath),
    [refreshTargets],
  );
  const setExplicit = useCallback(
    async (repoPath: string, branch: string, pr: PrFacts) => {
      await tuiRuntime.runPromise(
        PrCacheService.use((s) =>
          s.setExplicit(repoPath, branch, {
            baseRepository: pr.baseRepository,
            number: pr.number,
          }),
        ),
      );
      await refreshAfterCurrent(repoPath);
    },
    [refreshAfterCurrent],
  );
  const clearExplicit = useCallback(
    async (repoPath: string, branch: string) => {
      await tuiRuntime.runPromise(
        PrCacheService.use((s) => s.clearExplicit(repoPath, branch)),
      );
      await refreshAfterCurrent(repoPath);
    },
    [refreshAfterCurrent],
  );

  useEffect(() => {
    const present = new Set(reposRef.current.map((repo) => repo.repoPath));
    for (const path of observed.current.keys()) {
      if (present.has(path)) continue;
      inFlight.current.get(path)?.controller.abort();
      observed.current.delete(path);
      registrations.current.delete(path);
      discovery.current.delete(path);
      persisted.current.delete(path);
      loaded.current.delete(path);
      discoveryRetries.current.delete(path);
      baseRepositories.current.delete(path);
    }
    for (const repo of reposRef.current) {
      const signature = worktreeSignature(repo);
      if (observed.current.get(repo.repoPath) === signature) continue;
      const running = inFlight.current.get(repo.repoPath);
      const registration = registrations.current.get(repo.repoPath);
      if (registration !== undefined && registration !== repo.id) {
        running?.controller.abort();
        discovery.current.delete(repo.repoPath);
        persisted.current.delete(repo.repoPath);
        loaded.current.delete(repo.repoPath);
        discoveryRetries.current.delete(repo.repoPath);
        baseRepositories.current.delete(repo.repoPath);
        setAssociations(
          (previous) =>
            new Map(
              [...previous].filter(
                ([key]) => !key.startsWith(`${repo.repoPath}\0`),
              ),
            ),
        );
        setOpenPrs((previous) => {
          const next = new Map(previous);
          next.delete(repo.repoPath);
          return next;
        });
        setErrors((previous) => {
          const next = new Map(previous);
          next.delete(repo.repoPath);
          return next;
        });
      }
      registrations.current.set(repo.repoPath, repo.id);
      observed.current.set(repo.repoPath, signature);
      void refreshOne(repo.repoPath, "poll");
    }
  }, [repoSignature, refreshOne]);
  useEffect(() => {
    mounted.current = true;
    const flights = inFlight.current;
    const timer = setInterval(
      () => void refreshTargets("poll"),
      GITHUB_POLL_INTERVAL,
    );
    return () => {
      mounted.current = false;
      clearInterval(timer);
      for (const flight of flights.values()) flight.controller.abort();
    };
  }, [refreshTargets]);
  const prData = useMemo(() => {
    const data = new Map<string, PrFacts>();
    for (const [key, entry] of associations)
      if (entry.pr)
        data.set(key, {
          ...entry.pr,
          lastError: entry.lastError ?? entry.pr.lastError,
        });
    return data;
  }, [associations]);
  return {
    prData,
    associations,
    openPrs,
    errors,
    refresh,
    refreshCurrent,
    refreshAfterCurrent,
    refreshingProjects,
    setExplicit,
    clearExplicit,
  };
}

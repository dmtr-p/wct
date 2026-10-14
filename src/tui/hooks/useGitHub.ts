import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitHubService } from "../../services/github-service";
import {
  PrCacheService,
  type PrDiscoverySnapshot,
  type WorkspacePrEntry,
} from "../../services/pr-cache-service";
import { resolvePushDestination } from "../../services/pr-discovery";
import { checkSummary, type PrFacts } from "../../services/pr-model";
import {
  refreshPrDiscovery,
  refreshWorkspacePrs,
} from "../../services/pr-refresh";
import { workspaceIdentityKey } from "../lifecycle";
import { tuiRuntime } from "../runtime";
import type { PRInfo } from "../types";
import type { RepoInfo } from "./useRegistry";

const GITHUB_POLL_INTERVAL = 120_000;
const DISCOVERY_RETRY_DELAY = 600_000;
const CACHE_FRESH_WINDOW = 30_000;
type RefreshKind = "poll" | "manual" | "action";
interface RefreshFlight {
  promise: Promise<void>;
  controller: AbortController;
  history: boolean;
  discovered: boolean;
  succeeded: boolean;
  signature: string;
}
function worktreeSignature(repo: RepoInfo) {
  return JSON.stringify([
    repo.error,
    repo.worktrees.map((wt) => [wt.branch, wt.path, wt.isMainWorktree]),
  ]);
}
export function displayPr(pr: PrFacts): PRInfo {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    headRefName: pr.headRefName,
    rollupState: checkSummary(pr.checks, pr.checksComplete),
    facts: pr,
  };
}

function hydrate(repos: RepoInfo[]) {
  const associations = new Map<string, WorkspacePrEntry>();
  const openPrs = new Map<string, PRInfo[]>();
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
  const discovery = useRef(new Map<string, PrDiscoverySnapshot>());
  const loaded = useRef(new Set<string>());
  const discoveryRetries = useRef(new Map<string, number>());
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
      let requested = kind;
      let running = inFlight.current.get(repoPath);
      while (running) {
        await running.promise;
        if (signal?.aborted || !mounted.current) return;
        const current = currentRepo(repoPath);
        if (!current) return;
        // A completed full discovery satisfies a concurrent manual request.
        if (requested === "manual" && running.history && running.discovered)
          requested = "poll";
        if (
          requested === "poll" &&
          running.succeeded &&
          running.signature === worktreeSignature(current)
        )
          return;
        running = inFlight.current.get(repoPath);
      }
      if (signal?.aborted || !mounted.current || !currentRepo(repoPath)) return;
      const flight: RefreshFlight = {
        promise: Promise.resolve(),
        controller: new AbortController(),
        history: false,
        discovered: false,
        succeeded: false,
        signature: "",
      };
      inFlight.current.set(repoPath, flight);
      const active = () =>
        mounted.current &&
        !flight.controller.signal.aborted &&
        currentRepo(repoPath) !== undefined;
      flight.promise = (async () => {
        let historyPending = false;
        let historyBase: string | undefined;
        let showingRefresh = false;
        try {
          if (!loaded.current.has(repoPath)) {
            const cached = await tuiRuntime.runPromise(
              PrCacheService.use((s) => s.getDiscovery(repoPath)),
            );
            if (!active()) return;
            if (cached) discovery.current.set(repoPath, cached);
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
          if (!reuseFresh) {
            showingRefresh = true;
            setRefreshingProjects((previous) =>
              new Set(previous).add(repoPath),
            );
            const base = await tuiRuntime.runPromise(
              GitHubService.use((s) => s.resolveBaseRepo(repoPath)),
              opts,
            );
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
            // Persist repository discovery before workspace matching or detail reads.
            await tuiRuntime.runPromise(
              PrCacheService.use((s) => s.setDiscovery(repoPath, fetched)),
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
          await tuiRuntime.runPromise(
            PrCacheService.use((s) =>
              s.setOpenPrs(repoPath, open.map(displayPr)),
            ),
          );
          if (!active()) return;
          setOpenPrs((previous) =>
            new Map(previous).set(repoPath, open.map(displayPr)),
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
            const workspaces = await Promise.all(
              repo.worktrees
                .filter((wt) => !wt.isMainWorktree)
                .map(async (wt) => {
                  const [destination, explicit, cached] = await Promise.all([
                    tuiRuntime.runPromise(
                      resolvePushDestination(wt.path, wt.branch),
                      opts,
                    ),
                    tuiRuntime.runPromise(
                      PrCacheService.use((s) =>
                        s.getExplicit(repoPath, wt.branch),
                      ),
                    ),
                    tuiRuntime.runPromise(
                      PrCacheService.use((s) =>
                        s.getWorkspace(repoPath, wt.branch),
                      ),
                    ),
                  ]);
                  return { branch: wt.branch, destination, explicit, cached };
                }),
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
            await tuiRuntime.runPromise(
              PrCacheService.use((s) =>
                s.setDiscovery(repoPath, refreshed.snapshot),
              ),
            );
            if (!active()) return;
            discovery.current.set(repoPath, refreshed.snapshot);
            const latest = currentRepo(repoPath);
            if (!latest) return;
            if (worktreeSignature(latest) !== signature) continue;
            const found = new Map(
              [...refreshed.entries].map(([branch, entry]) => [
                workspaceIdentityKey(repoPath, branch),
                entry,
              ]),
            );
            await Promise.all(
              [...refreshed.entries].map(([branch, entry]) =>
                tuiRuntime.runPromise(
                  PrCacheService.use((s) =>
                    s.setWorkspace(repoPath, branch, entry),
                  ),
                ),
              ),
            );
            if (!isCurrent()) continue;
            if (!repo.error)
              await tuiRuntime.runPromise(
                PrCacheService.use((s) =>
                  s.pruneWorkspaces(
                    repoPath,
                    workspaces.map((wt) => wt.branch),
                  ),
                ),
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
            const error = [...found.values()].find(
              (entry) => entry.lastError,
            )?.lastError;
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
          // A failed associated PR cannot invalidate a completed history scan.
          if (
            historyPending &&
            discovery.current.get(repoPath)?.baseRepository.toLowerCase() !==
              historyBase?.toLowerCase()
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
                  s.setWorkspaceError(repoPath, wt.branch, message),
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
      discovery.current.delete(path);
      loaded.current.delete(path);
      discoveryRetries.current.delete(path);
    }
    for (const repo of reposRef.current) {
      const signature = worktreeSignature(repo);
      if (observed.current.get(repo.repoPath) === signature) continue;
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
    const data = new Map<string, PRInfo>();
    for (const [key, entry] of associations)
      if (entry.pr)
        data.set(
          key,
          displayPr({
            ...entry.pr,
            lastError: entry.lastError ?? entry.pr.lastError,
          }),
        );
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

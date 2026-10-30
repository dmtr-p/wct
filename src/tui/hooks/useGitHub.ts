import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PrCacheService,
  type WorkspacePrEntry,
} from "../../services/pr-cache-service";
import type { OpenPrChoice, PrFacts } from "../../services/pr-model";
import {
  PrRefreshService,
  type PrRefreshSession,
} from "../../services/pr-refresh-service";
import { workspaceIdentityKey } from "../lifecycle";
import { tuiRuntime } from "../runtime";
import type { RepoInfo } from "./useRegistry";

const GITHUB_POLL_INTERVAL = 120_000;

interface HydratedRegistration {
  id: string;
  branches: Set<string>;
  openPrs: boolean;
}

function hydrate(
  repos: RepoInfo[],
  processed: Map<string, HydratedRegistration>,
) {
  const associations = new Map<string, WorkspacePrEntry>();
  const openPrs = new Map<string, OpenPrChoice[]>();
  const reset = new Set<string>();
  const present = new Set(repos.map((repo) => repo.repoPath));
  for (const path of processed.keys()) {
    if (present.has(path)) continue;
    processed.delete(path);
    reset.add(path);
  }
  for (const repo of repos) {
    const previous = processed.get(repo.repoPath);
    const registration =
      previous?.id === repo.id
        ? previous
        : { id: repo.id, branches: new Set<string>(), openPrs: false };
    if (previous && previous !== registration) reset.add(repo.repoPath);
    processed.set(repo.repoPath, registration);
    const presentBranches = new Set(repo.worktrees.map((wt) => wt.branch));
    // Refreshes can evict absent Workspaces while their persisted cache survives.
    for (const branch of registration.branches) {
      if (!presentBranches.has(branch)) registration.branches.delete(branch);
    }
    const branches = [...presentBranches].filter(
      (branch) => !registration.branches.has(branch),
    );
    const includeOpenPrs = !registration.openPrs;
    if (!includeOpenPrs && branches.length === 0) continue;
    try {
      const cached = tuiRuntime.runSync(
        PrCacheService.use((s) =>
          s.getHydration(repo.repoPath, branches, includeOpenPrs),
        ),
      );
      if (includeOpenPrs && cached.openPrs)
        openPrs.set(
          repo.repoPath,
          cached.openPrs.payload.filter((pr) => pr.state === "OPEN"),
        );
      for (const workspace of cached.workspaces) {
        if (workspace.cached)
          associations.set(
            workspaceIdentityKey(repo.repoPath, workspace.branch),
            workspace.cached,
          );
      }
      // A successful miss is processed too; failures can retry on the next poll.
      registration.openPrs = true;
      for (const branch of branches) registration.branches.add(branch);
    } catch {
      /* cache errors leave unknown data */
    }
  }
  return { associations, openPrs, reset };
}

export function useGitHub(repos: RepoInfo[]) {
  const [initial] = useState(() => {
    const processed = new Map<string, HydratedRegistration>();
    return { ...hydrate(repos, processed), processed };
  });
  const hydrated = useRef(initial.processed);
  const [associations, setAssociations] = useState(initial.associations);
  const [openPrs, setOpenPrs] = useState(initial.openPrs);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [refreshingProjects, setRefreshingProjects] = useState<Set<string>>(
    new Set(),
  );
  const reposRef = useRef(repos);
  reposRef.current = repos;
  const session = useRef<Promise<PrRefreshSession> | null>(null);

  useEffect(() => {
    const cached = hydrate(repos, hydrated.current);
    if (
      cached.reset.size === 0 &&
      cached.associations.size === 0 &&
      cached.openPrs.size === 0
    )
      return;
    setAssociations((previous) => {
      const next = new Map(
        [...previous].filter(
          ([key]) => !cached.reset.has(key.slice(0, key.indexOf("\0"))),
        ),
      );
      for (const [key, entry] of cached.associations)
        if (!next.has(key)) next.set(key, entry);
      return next;
    });
    setOpenPrs((previous) => {
      const next = new Map(previous);
      for (const path of cached.reset) next.delete(path);
      for (const [key, prs] of cached.openPrs)
        if (!next.has(key)) next.set(key, prs);
      return next;
    });
  }, [repos]);

  useEffect(() => {
    let attached = true;
    const observe =
      <A>(publish: (update: (previous: A) => A) => void) =>
      (update: (previous: A) => A) => {
        if (attached)
          publish((previous) => (attached ? update(previous) : previous));
      };
    const owned = tuiRuntime.runPromise(
      PrRefreshService.use((service) =>
        service.openSession({
          associations: observe(setAssociations),
          openPrs: observe(setOpenPrs),
          errors: observe(setErrors),
          refreshing: observe(setRefreshingProjects),
        }),
      ),
    );
    session.current = owned;
    void owned.then((value) =>
      tuiRuntime.runPromise(value.updateRepositories(reposRef.current)),
    );
    const timer = setInterval(() => {
      void owned.then((value) => tuiRuntime.runPromise(value.refresh("poll")));
    }, GITHUB_POLL_INTERVAL);
    return () => {
      attached = false;
      clearInterval(timer);
      session.current = null;
      void owned.then((value) => tuiRuntime.runPromise(value.close));
    };
  }, []);
  useEffect(() => {
    const owned = session.current;
    if (owned)
      void owned.then((value) =>
        tuiRuntime.runPromise(value.updateRepositories(repos)),
      );
  }, [repos]);
  const refreshTargets = useCallback(
    async (
      kind: "poll" | "manual" | "action",
      repoPath?: string,
      signal?: AbortSignal,
    ) => {
      const owned = session.current;
      if (!owned || signal?.aborted) return;
      const value = await owned;
      if (signal?.aborted || session.current !== owned) return;
      await tuiRuntime
        .runPromise(value.refresh(kind, repoPath), { signal })
        .catch((cause) => {
          if (!signal?.aborted) throw cause;
        });
    },
    [],
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
    async (path: string, branch: string, pr: PrFacts) => {
      const value = await session.current;
      if (value)
        await tuiRuntime.runPromise(value.setExplicit(path, branch, pr));
    },
    [],
  );
  const clearExplicit = useCallback(async (path: string, branch: string) => {
    const value = await session.current;
    if (value) await tuiRuntime.runPromise(value.clearExplicit(path, branch));
  }, []);
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

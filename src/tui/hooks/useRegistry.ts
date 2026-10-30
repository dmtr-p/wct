import { useCallback, useEffect, useState } from "react";
import { LocalObservationService } from "../../services/local-observation-service";
import type { RepoInfo } from "../../services/local-observation-service";
import { tuiRuntime } from "../runtime";
import { useRefreshGeneration } from "./useRefreshGeneration";
export type {
  RepoInfo,
  WorktreeInfo,
} from "../../services/local-observation-service";

export function useRegistry() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const { begin } = useRefreshGeneration();

  // Return this request's snapshot even when a newer one is already displayed.
  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<RepoInfo[] | null> => {
      const request = begin(signal);
      if (!request.isActive()) return null;
      const opts = { signal: request.signal };
      try {
        const repoInfos = await tuiRuntime.runPromise(
          LocalObservationService.use((service) => service.repositories),
          opts,
        );
        if (!request.isActive()) return null;
        if (request.accept()) setRepos(repoInfos);
        return repoInfos;
      } catch {
        // Swallow — previous repos preserved, next poll/watch will retry
        return null;
      } finally {
        if (request.accept()) setLoading(false);
      }
    },
    [begin],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return { repos, loading, refresh };
}

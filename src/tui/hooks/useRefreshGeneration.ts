import { useCallback, useLayoutEffect, useRef } from "react";

export function useRefreshGeneration() {
  const generation = useRef(0);
  const accepted = useRef(0);
  const mounted = useRef(false);
  const lifetime = useRef(0);

  const invalidate = useCallback(() => {
    accepted.current = ++generation.current;
    return mounted.current;
  }, []);

  const begin = useCallback((signal?: AbortSignal) => {
    const current = ++generation.current;
    const startedIn = lifetime.current;
    // Lifecycle validation still needs a superseded request's own snapshot.
    const isActive = () =>
      mounted.current && lifetime.current === startedIn && !signal?.aborted;
    return {
      isActive,
      accept: () => {
        // Polling can start newer scans before a slow scan finishes.
        if (!isActive() || current < accepted.current) return false;
        accepted.current = current;
        return true;
      },
    };
  }, []);

  // Layout cleanup must run before queued promise continuations.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifetime.current += 1;
      generation.current += 1;
    };
  }, []);

  return { begin, invalidate };
}

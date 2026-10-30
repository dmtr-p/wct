import { useCallback, useLayoutEffect, useRef } from "react";

/** Fresh observations publish without regressing the accepted request order. */
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
    // Superseded callers still need their own post-request snapshot for
    // lifecycle validation. Cancellation, unlike supersession, discards it.
    const isActive = () =>
      mounted.current && lifetime.current === startedIn && !signal?.aborted;
    return {
      isActive,
      accept: () => {
        // Starting another scan must not starve slower observations. Only a
        // newer accepted result (or an action invalidation) makes this obsolete.
        if (!isActive() || current < accepted.current) return false;
        accepted.current = current;
        return true;
      },
    };
  }, []);

  // Invalidate synchronously on unmount, before pending promise continuations.
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

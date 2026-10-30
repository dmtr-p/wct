import { useCallback, useLayoutEffect, useRef } from "react";

export function useRefreshGeneration() {
  const generation = useRef(0);
  const accepted = useRef(0);
  const mounted = useRef(false);
  const lifetime = useRef(0);
  const cancellation = useRef(new AbortController());

  const invalidate = useCallback(() => {
    accepted.current = ++generation.current;
    return mounted.current;
  }, []);

  const begin = useCallback((signal?: AbortSignal) => {
    const current = ++generation.current;
    const startedIn = lifetime.current;
    // Superseded requests can still return snapshots for lifecycle validation.
    const isActive = () =>
      mounted.current && lifetime.current === startedIn && !signal?.aborted;
    return {
      signal: signal
        ? AbortSignal.any([signal, cancellation.current.signal])
        : cancellation.current.signal,
      isActive,
      accept: () => {
        if (!isActive() || current < accepted.current) return false;
        accepted.current = current;
        return true;
      },
    };
  }, []);

  // Layout cleanup must run before queued promise continuations.
  useLayoutEffect(() => {
    cancellation.current = new AbortController();
    mounted.current = true;
    return () => {
      cancellation.current.abort();
      mounted.current = false;
      lifetime.current += 1;
      generation.current += 1;
    };
  }, []);

  return { begin, invalidate };
}

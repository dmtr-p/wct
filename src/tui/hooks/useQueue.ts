import { useCallback, useEffect, useState } from "react";
import { type QueueItem, QueueStorage } from "../../services/queue-storage";
import { tuiRuntime } from "../runtime";

export function useQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await tuiRuntime.runPromise(
        QueueStorage.use((s) =>
          s.listItems({ validatePanes: true, logWarnings: false }),
        ),
        signal ? { signal } : undefined,
      );
      setItems(result);
    } catch {
      // Silently fail on queue read errors
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return { items, refresh };
}

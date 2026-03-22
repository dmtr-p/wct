import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import { liveQueueStorage, type QueueItem } from "../../services/queue-storage";

export function useQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await Effect.runPromise(
        liveQueueStorage.listItems({ validatePanes: true, logWarnings: false }),
      );
      setItems(result);
    } catch {
      // Silently fail on queue read errors
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { items, refresh };
}

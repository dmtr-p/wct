import { useCallback, useEffect, useState } from "react";
import { type QueueItem, QueueStorage } from "../../services/queue-storage";
import { tuiRuntime } from "../runtime";

export function useQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await tuiRuntime.runPromise(
        QueueStorage.use((s) =>
          s.listItems({ validatePanes: true, logWarnings: false }),
        ),
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

import { watch } from "node:fs";
import { useEffect, useRef } from "react";

const POLL_INTERVAL_MS = 5000;

export function useRefresh(onRefresh: () => void | Promise<void>) {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    // Slow poll fallback
    const interval = setInterval(() => {
      refreshRef.current();
    }, POLL_INTERVAL_MS);

    // Watch ~/.wct/ directory for DB changes
    const wctDir = `${process.env.HOME ?? "/tmp"}/.wct`;
    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(wctDir, (_eventType, filename) => {
        if (
          filename &&
          (filename.endsWith(".db") || filename.endsWith("-wal"))
        ) {
          refreshRef.current();
        }
      });
    } catch {
      // Directory may not exist yet — poll will still work
    }

    return () => {
      clearInterval(interval);
      watcher?.close();
    };
  }, []);
}

import { useEffect, useState } from "react";

/**
 * Returns a boolean that toggles every `intervalMs` milliseconds.
 * Use to show/hide a cursor character.
 */
export function useBlink(intervalMs = 500): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setVisible((v) => !v), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return visible;
}

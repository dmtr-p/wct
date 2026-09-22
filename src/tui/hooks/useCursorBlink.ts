import { useLayoutEffect, useRef, useState } from "react";
import { useBlink } from "./useBlink";

/** Keep an editing cursor visible while the user is actively moving it. */
export function useCursorBlink(
  value: string,
  cursor: number,
  isFocused: boolean,
  holdMs = 700,
): boolean {
  const blinking = useBlink();
  const activityKey = JSON.stringify([value, cursor, isFocused]);
  const previousActivityKey = useRef(activityKey);
  const [heldVisible, setHeldVisible] = useState(false);

  useLayoutEffect(() => {
    if (activityKey === previousActivityKey.current) return;
    previousActivityKey.current = activityKey;
    if (!isFocused) {
      setHeldVisible(false);
      return;
    }
    setHeldVisible(true);
    const timer = setTimeout(() => setHeldVisible(false), holdMs);
    return () => clearTimeout(timer);
  }, [activityKey, holdMs, isFocused]);

  return heldVisible || blinking;
}

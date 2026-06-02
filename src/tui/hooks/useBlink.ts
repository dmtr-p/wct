import { useAnimation } from "ink";

/**
 * Returns a boolean that toggles every `intervalMs` milliseconds.
 * Use to show/hide a cursor character.
 */
export function useBlink(intervalMs = 500): boolean {
  const { frame } = useAnimation({ interval: intervalMs });
  return frame % 2 === 0;
}

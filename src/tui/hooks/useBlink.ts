import { useAnimation } from "ink";

export function useBlink(intervalMs = 500): boolean {
  const { frame } = useAnimation({ interval: intervalMs });
  return frame % 2 === 0;
}

import { type Key, useInput, useStdin } from "ink";
import { useEffect, useEffectEvent } from "react";
import {
  isMouseSequence,
  type MouseEvent,
  parseSgrMouse,
  splitMouseSequences,
} from "../input/mouse";
import { subscribeMouseInput } from "../input/terminal-input";

export interface GuardedInputOptions {
  /** Enable both keyboard and mouse callbacks. Defaults to true. */
  isActive?: boolean;
  /**
   * Receives actionable mouse reports in terminal input order.
   */
  onMouseEvent?: (event: MouseEvent) => void;
}

/**
 * Shared keyboard and mouse input hook (ADR 0002). Ink handles keyboard events;
 * the terminal adapter supplies mouse reports. The string guard covers Ink's
 * paste fallback when no usePaste listener is registered. Biome restricts
 * direct useInput imports to this file.
 */
export function useGuardedInput(
  handler: (input: string, key: Key) => void,
  options: GuardedInputOptions = {},
): void {
  const { isActive = true, onMouseEvent } = options;
  const { stdin } = useStdin();
  const handleMouse = useEffectEvent((event: MouseEvent) => {
    onMouseEvent?.(event);
  });
  useEffect(() => {
    if (!isActive) return;
    return subscribeMouseInput(stdin, handleMouse);
  }, [stdin, isActive]);
  useInput(
    (input, key) => {
      if (isMouseSequence(input)) {
        if (onMouseEvent) {
          for (const sequence of splitMouseSequences(input)) {
            const event = parseSgrMouse(sequence);
            if (event) onMouseEvent(event);
          }
        }
        return;
      }
      handler(input, key);
    },
    { isActive },
  );
}

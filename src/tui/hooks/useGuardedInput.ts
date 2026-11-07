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
  isActive?: boolean;
  onMouseEvent?: (event: MouseEvent) => void;
}

/**
 * Mouse-only paste fallback must be swallowed when no usePaste listener is
 * registered; otherwise Ink delivers mouse reports as keyboard input.
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

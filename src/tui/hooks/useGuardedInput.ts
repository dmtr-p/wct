// This hook is the single allowed `useInput` call site — the biome.json
// override for this file switches off the repo-wide noRestrictedImports rule.
import { type Key, useInput } from "ink";
import {
  isMouseSequence,
  type MouseEvent,
  parseSgrMouse,
  splitMouseSequences,
} from "../input/mouse";

export interface GuardedInputOptions {
  /** Same as Ink's `useInput` option. Defaults to `true`. */
  isActive?: boolean;
  /**
   * Called for each ACTIONABLE mouse event parsed out of a swallowed input
   * string, in order. Ink 7.1 delivers ONE SGR sequence per `useInput` event
   * (its parser splits stdin chunks and strips the leading ESC per event),
   * so this normally fires at most once per call; iterating a multi-sequence
   * string is defense-in-depth for Ink's bracketed-paste fallback and any
   * future delivery change. Only App.tsx's dispatcher passes this; every
   * other consumer just needs the sequences swallowed.
   */
  onMouseEvent?: (event: MouseEvent) => void;
}

/**
 * The ONLY way `wct tui` components may listen to Ink input. Wraps Ink's
 * `useInput` and swallows every SGR mouse escape sequence before it can
 * reach `handler` as printable input — Ink dispatches every input event to
 * ALL active `useInput` hooks (one sequence per event on the normal stdin
 * path; multi-sequence strings only via the bracketed-paste fallback), so a
 * guard living only in App.tsx's dispatcher leaves every modal/text-input
 * handler pasting raw `[<0;12;38M…` bytes into its field — that per-hook gap
 * was the real cause of the screenshot garble (three per-sequence events
 * appended in order). Centralising the guard here keeps the invariant true
 * for handlers added in the future; a biome `noRestrictedImports` rule
 * forbids importing `useInput` from "ink" anywhere else (this file carries
 * the sole override).
 *
 * Mouse parsing stays on Ink's own read loop — no second stdin listener
 * (ADR 0002: docs/adr/0002-parse-mouse-from-ink-useinput.md).
 */
export function useGuardedInput(
  handler: (input: string, key: Key) => void,
  options: GuardedInputOptions = {},
): void {
  const { isActive = true, onMouseEvent } = options;
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

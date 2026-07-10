// This hook is the single allowed `useInput` call site — the biome.json
// override for this file switches off the repo-wide noRestrictedImports rule.
import { type Key, useInput } from "ink";
import { useRef } from "react";
import {
  isMouseSequence,
  isX10MousePrefix,
  type MouseEvent,
  parseSgrMouse,
  splitMouseSequences,
  X10_PAYLOAD_BYTES,
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
  // Legacy X10 reports (terminal honors ?1000 but not ?1006) split into an
  // `ESC [ M` event plus a separate 3-raw-byte payload event that has no
  // recognisable mouse shape — so seeing the prefix arms a byte-counted
  // swallow of the payload that follows. Per-hook state: Ink dispatches every
  // event to every active hook, so each instance sees the same stream and
  // arms/drains its own counter identically.
  const x10PayloadRemaining = useRef(0);
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
      if (isX10MousePrefix(input)) {
        x10PayloadRemaining.current = X10_PAYLOAD_BYTES;
        return;
      }
      if (x10PayloadRemaining.current > 0) {
        // Payload bytes may arrive in one event or split across several.
        // Count RAW bytes, not string length: coordinate bytes for col/row
        // > 95 are ≥ 0x80, and stdin's UTF-8 decode (Ink setEncoding's
        // string_decoder) transforms them two ways. A byte run that happens
        // to BE valid UTF-8 merges into one multi-byte character —
        // `input.length` would undercount, leave the counter armed, and eat
        // the next real keystroke; `Buffer.byteLength` recovers the raw
        // count exactly. A byte that is NOT valid UTF-8 (e.g. a lone
        // continuation byte — any col ≥ 96 with an ASCII row) becomes
        // U+FFFD, which weighs 3 UTF-8 bytes for what was ONE raw byte —
        // uncorrected, the inflated count overshoots the counter and the
        // payload garbage falls through to the handler, so count each
        // replacement char as the single raw byte it stands in for.
        // Anything still longer than the remaining payload is not X10
        // payload (drop the counter and let the handler have it — a real
        // keystroke, never payload), and an empty `input` is a special key
        // (arrow/escape), never payload bytes.
        const replacements = input.split("�").length - 1;
        const bytes = Buffer.byteLength(input, "utf8") - 2 * replacements;
        if (bytes > 0 && bytes <= x10PayloadRemaining.current) {
          x10PayloadRemaining.current -= bytes;
          return;
        }
        x10PayloadRemaining.current = 0;
      }
      handler(input, key);
    },
    { isActive },
  );
}

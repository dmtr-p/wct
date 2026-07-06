import type { RepoInfo } from "../hooks/useRegistry";
import {
  isInertTreeItem,
  isWithinExpandedSubtree,
  type TreeRow,
} from "../tree-helpers";
import type { Mode, TreeItem } from "../types";

/**
 * Rows of fixed chrome above the tree viewport: the `wct` header line + a blank
 * spacer line. A 1-based SGR mouse `row` maps to a viewport row by subtracting
 * this offset (and the 1-based → 0-based conversion).
 */
export const HEADER_OFFSET = 2;

/** SGR extended mouse event (DECSET ?1006). ESC is already stripped by Ink. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC (\x1b) byte is the literal start of an SGR mouse sequence and must be matched
const SGR = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * One or more concatenated SGR sequences. On the normal stdin path Ink 7.1
 * delivers exactly ONE sequence per `useInput` call: its input parser
 * (ink/build/input-parser.js) splits each complete CSI sequence in a chunk
 * into its own event ('<', digits, ';' are parameter bytes, 'M'/'m' finals;
 * truncated tails are held pending and reassembled), and use-input.js strips
 * the leading ESC of EACH event. The only path that can hand `useInput` a
 * multi-sequence (or inner-ESC) string is Ink's bracketed-paste fallback
 * (`emitInput(event.paste)` when no paste listener is registered) carrying
 * mouse-shaped pasted text. Accepting one-or-more sequences here is
 * defense-in-depth for that path — and for any future change in Ink's
 * delivery model — NOT a description of normal stdin behaviour.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: see SGR above
const SGR_CHUNK = /^(?:\x1b?\[<\d+;\d+;\d+[Mm])+$/;

/** Global matcher used to split a mouse-only chunk into single sequences. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: see SGR above
const SGR_SPLIT = /\x1b?\[<\d+;\d+;\d+[Mm]/g;

/**
 * Legacy X10 mouse-report prefix (`ESC [ M`). `MOUSE_ENABLE` requests ?1000
 * (report clicks) and ?1006 (SGR encoding) together; a terminal that honors
 * ?1000 but ignores ?1006 (PuTTY < 0.77, urxvt < 9.25, old mosh) reports in
 * X10 encoding instead: `ESC [ M` followed by exactly 3 raw bytes (button+32,
 * col+32, row+32). Ink's input parser terminates the CSI at the `M` final
 * byte, so the prefix arrives as its own `useInput` event (leading ESC
 * stripped) and the 3 coordinate bytes — often printable characters — arrive
 * as a SEPARATE event that `isMouseSequence` cannot recognise by shape. The
 * guard uses this predicate to swallow the prefix AND arm a 3-byte swallow
 * for the bytes that follow, so a click on such a terminal cannot type junk
 * into Search or a modal text field. X10 events are only swallowed, never
 * acted on: acting requires SGR.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: see SGR above
const X10_PREFIX = /^\x1b?\[M$/;

/** Bytes of X10 payload (button, col, row) that follow an `ESC [ M` prefix. */
export const X10_PAYLOAD_BYTES = 3;

export function isX10MousePrefix(input: string): boolean {
  return X10_PREFIX.test(input);
}

export type MouseEvent =
  | { kind: "wheel"; dir: 1 | -1 }
  | {
      kind: "press";
      button: "left" | "middle" | "right";
      col: number;
      row: number;
    };

/**
 * True for ANY SGR mouse escape sequence — press, release, motion/drag, and
 * extra-button events alike — regardless of whether `parseSgrMouse` resolves
 * it to an actionable `MouseEvent`. Used by the `useInput` dispatcher guard to
 * swallow every mouse sequence (ADR 0002 / PRD §6.6): a click emits BOTH a
 * press and a release sequence, and `parseSgrMouse` intentionally returns
 * `null` for the release half (and for motion/extra-button events) because
 * those are not actionable — but non-actionable is not the same as "not a
 * mouse sequence." Falling through the dispatcher guard would let those bytes
 * reach mode-specific handlers (e.g. Search's text input), corrupting state.
 *
 * Also true for a string of several concatenated sequences (see `SGR_CHUNK` —
 * normal stdin delivery is one sequence per event; the multi-sequence form
 * only occurs via Ink's paste fallback and is handled as defense-in-depth).
 * Semantics: input is swallowed as mouse only when it is ENTIRELY mouse
 * sequences. A mixed string like `a[<0;5;5M` is NOT swallowed — swallowing
 * it would drop the user's keystroke. Accepted trade-off: a bracketed paste
 * whose text is exactly one-or-more mouse-shaped tokens (someone literally
 * pasting `[<0;12;38M` into a text field) is swallowed as mouse input; that
 * case is vanishingly rare and inherent to shape-based guarding.
 *
 * Kept as a separate, pure predicate so `parseSgrMouse` stays single-sequence.
 */
export function isMouseSequence(input: string): boolean {
  return SGR_CHUNK.test(input);
}

/**
 * Split a mouse-only string into its individual SGR sequences, in order,
 * each consumable by `parseSgrMouse`. On the normal stdin path Ink already
 * delivers one sequence per event, so this usually yields a single element;
 * if a multi-sequence string ever arrives (paste fallback, or a future Ink
 * delivery change) dispatch iterates ALL of them — e.g. two wheel ticks must
 * scroll twice, never just the first. Returns `[]` for anything
 * `isMouseSequence` rejects (mixed or non-mouse input is a keyboard concern,
 * not ours).
 */
export function splitMouseSequences(input: string): string[] {
  if (!isMouseSequence(input)) return [];
  return input.match(SGR_SPLIT) ?? [];
}

/**
 * Parse a single SGR mouse sequence out of the string Ink forwards to
 * `useInput`. Returns `null` for anything that is not a recognised mouse event
 * we act on (release, motion/drag, malformed input).
 *
 * The button is decoded with a BITMASK — never `Cb % 4`, which turns wheel-up
 * (Cb 64) into button 0 and misfires clicks on scroll (Ink PR #955 bug).
 */
export function parseSgrMouse(input: string): MouseEvent | null {
  const m = SGR.exec(input);
  if (!m) return null;
  const cb = Number(m[1]);
  const col = Number(m[2]); // 1-based
  const row = Number(m[3]); // 1-based
  const isRelease = m[4] === "m";
  if ((cb & 64) === 64) {
    // wheel: the low 2 bits distinguish 64 = up, 65 = down, 66 = wheel-left,
    // 67 = wheel-right (tilt wheel / horizontal trackpad swipe). Horizontal
    // ticks must be ignored, not decoded by bit 0 as vertical scrolling.
    if ((cb & 3) >= 2) return null;
    return { kind: "wheel", dir: (cb & 1) === 0 ? -1 : 1 };
  }
  if (cb & 32) return null; // motion/drag — ignored in v1
  if (isRelease) return null; // act on press only
  // Additional buttons (8+: back/forward on multi-button mice) set bit 7 and
  // would otherwise misdecode as a left press via `(cb & 3) === 0`. Ignore them.
  if (cb & 0x80) return null;
  const button = (cb & 3) === 0 ? "left" : (cb & 3) === 1 ? "middle" : "right";
  return { kind: "press", button, col, row };
}

export interface MouseActionContext {
  mode: Mode;
  rows: TreeRow[];
  /** The CLAMPED offset the render is sliced with — never the raw scrollOffset. */
  effectiveScrollOffset: number;
  viewportRows: number;
  treeItems: TreeItem[];
  repos: RepoInfo[];
  expandedWorktreeKey: string | null;
}

export type MouseAction =
  | { kind: "none" }
  | { kind: "scroll"; delta: 1 | -1 }
  | { kind: "select"; itemIndex: number }
  | { kind: "selectAndExitExpanded"; itemIndex: number };

/**
 * Resolve a parsed mouse event into a pure description of what should happen,
 * testable without React. Only Navigate and Expanded mode act on mouse; every
 * other mode (modals, Search, confirmations) resolves to `none` (the event is
 * still swallowed upstream so no escape garble reaches the screen).
 *
 * - Wheel → scroll only; the selection is untouched and may scroll out of view.
 * - Left-click → hit-test the row under the cursor and select it. In Expanded
 *   mode, a click within the expanded worktree's subtree stays; a click outside
 *   exits to Navigate. Non-left buttons and clicks on chrome/phantom rows or
 *   inert pane-header rows (which keyboard navigation also skips) are `none`.
 */
export function resolveMouseAction(
  event: MouseEvent,
  ctx: MouseActionContext,
): MouseAction {
  if (ctx.mode.type !== "Navigate" && ctx.mode.type !== "Expanded") {
    return { kind: "none" };
  }

  if (event.kind === "wheel") {
    return { kind: "scroll", delta: event.dir };
  }

  if (event.button !== "left") {
    return { kind: "none" };
  }

  // Hit-test: map the 1-based SGR row to a visible row, then to its item.
  const viewportRow = event.row - 1 - HEADER_OFFSET;
  if (viewportRow < 0 || viewportRow >= ctx.viewportRows) {
    return { kind: "none" }; // header / StatusBar / below the viewport
  }
  const row = ctx.rows[ctx.effectiveScrollOffset + viewportRow];
  const itemIndex = row?.itemIndex;
  if (itemIndex == null) {
    return { kind: "none" }; // phantom row / padding
  }

  // Inert rows (pane headers) are skipped by keyboard navigation via the same
  // shared predicate, so a click cannot select a row arrow keys refuse.
  if (isInertTreeItem(ctx.treeItems[itemIndex])) {
    return { kind: "none" };
  }

  if (ctx.mode.type === "Navigate") {
    return { kind: "select", itemIndex };
  }

  // Expanded: stay if the click landed within the expanded worktree's subtree,
  // otherwise exit to Navigate and select the clicked row.
  if (
    isWithinExpandedSubtree(
      ctx.treeItems,
      itemIndex,
      ctx.expandedWorktreeKey,
      ctx.repos,
    )
  ) {
    return { kind: "select", itemIndex };
  }
  return { kind: "selectAndExitExpanded", itemIndex };
}

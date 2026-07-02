import type { RepoInfo } from "../hooks/useRegistry";
import { isWithinExpandedSubtree, type TreeRow } from "../tree-helpers";
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
 * Matches the same anchored SGR shape as `parseSgrMouse`'s regex; kept as a
 * separate, pure predicate so `parseSgrMouse` itself stays unchanged.
 */
export function isMouseSequence(input: string): boolean {
  return SGR.test(input);
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
    // wheel: 64 = up, 65 = down (up → -1, down → +1)
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

  // Pane headers are inert separators the keyboard can never land on
  // (createNavigateTree skips them with this exact predicate); mirror that so
  // a click cannot select a row that follow-up keys treat inconsistently.
  const item = ctx.treeItems[itemIndex];
  if (item?.type === "detail" && item.detailKind === "pane-header") {
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

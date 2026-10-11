import type { RepoInfo } from "../hooks/useRegistry";
import { workspaceIdentityKey } from "../lifecycle";
import { isInertTreeItem, type TreeRow } from "../tree-helpers";
import { type Mode, type TreeItem, worktreeDisplayKey } from "../types";

/**
 * Rows of fixed chrome above the tree viewport: the `wct` header line + a blank
 * spacer line. A 1-based SGR mouse `row` maps to a viewport row by subtracting
 * this offset (and the 1-based → 0-based conversion).
 */
export const HEADER_OFFSET = 2;
export const ADD_PROJECT_BUTTON_LABEL = "[+Add]";

/** SGR extended mouse event (DECSET ?1006), with an optional stripped ESC. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC (\x1b) byte is the literal start of an SGR mouse sequence and must be matched
const SGR = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Mouse-only strings from Ink's paste fallback, with or without ESC prefixes.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: see SGR above
const SGR_CHUNK = /^(?:\x1b?\[<\d+;\d+;\d+[Mm])+$/;

/** Global matcher used to split a mouse-only chunk into single sequences. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: see SGR above
const SGR_SPLIT = /\x1b?\[<\d+;\d+;\d+[Mm]/g;

/**
 * X10 reports use ESC [ M followed by three raw bytes: button+32, col+32,
 * row+32. Ink discards the prefix; the adapter removes the payload before
 * UTF-8 decoding. Terminals that ignore SGR encoding may send this format.
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
  | { kind: "move"; col: number; row: number }
  | {
      kind: "press";
      button: "left" | "middle" | "right";
      col: number;
      row: number;
    };

export function isAddProjectButtonTarget(
  event: MouseEvent,
  mode: Mode,
  terminalColumns: number,
): boolean {
  if (mode.type !== "Navigate" && mode.type !== "Expanded") return false;
  if (event.kind === "wheel" || event.row !== 1) {
    return false;
  }

  const firstButtonColumn = Math.max(
    1,
    terminalColumns - ADD_PROJECT_BUTTON_LABEL.length + 1,
  );
  return event.col >= firstButtonColumn && event.col <= terminalColumns;
}

export function isAddProjectButtonPress(
  event: MouseEvent,
  mode: Mode,
  terminalColumns: number,
): boolean {
  return (
    event.kind === "press" &&
    event.button === "left" &&
    isAddProjectButtonTarget(event, mode, terminalColumns)
  );
}

export interface MouseClickHistory {
  targetId: string;
  timestamp: number;
}

export const DOUBLE_CLICK_INTERVAL_MS = 400;

export function mouseClickTargetId(itemId: string, rowIndex: number): string {
  return `${itemId}:row:${rowIndex}`;
}

export function detectDoubleClick(
  previous: MouseClickHistory | null,
  targetId: string,
  timestamp: number,
): { isDoubleClick: boolean; history: MouseClickHistory | null } {
  const elapsed = previous ? timestamp - previous.timestamp : -1;
  const isDoubleClick =
    previous?.targetId === targetId &&
    elapsed >= 0 &&
    elapsed <= DOUBLE_CLICK_INTERVAL_MS;
  return {
    isDoubleClick,
    history: isDoubleClick ? null : { targetId, timestamp },
  };
}

export type TreeDoubleClickAction =
  | { type: "noop" }
  | { type: "expand-worktree"; worktreeKey: string }
  | {
      type: "collapse-worktree";
      worktreeKey: string;
      repoPath: string;
      branch: string;
    }
  | { type: "activate-detail"; action: () => void };

export function resolveTreeDoubleClickAction(
  item: TreeItem,
  repos: RepoInfo[],
  expandedWorktreeKeys: Set<string>,
  discoveredWorkspaceKeys: Set<string> = new Set(),
): TreeDoubleClickAction {
  if (item.type === "worktree") {
    const repo = repos[item.repoIndex];
    const worktree = repo?.worktrees[item.worktreeIndex];
    if (!repo || !worktree) return { type: "noop" };
    const worktreeKey = worktreeDisplayKey(repo.project, worktree.branch);
    return expandedWorktreeKeys.has(worktreeKey) ||
      discoveredWorkspaceKeys.has(
        workspaceIdentityKey(repo.repoPath, worktree.branch),
      )
      ? {
          type: "collapse-worktree",
          worktreeKey,
          repoPath: repo.repoPath,
          branch: worktree.branch,
        }
      : { type: "expand-worktree", worktreeKey };
  }
  if (
    item.type === "detail" &&
    (item.detailKind === "pane" ||
      (item.detailKind === "pr" && !item.meta.prKey)) &&
    item.action
  ) {
    return { type: "activate-detail", action: item.action };
  }
  return { type: "noop" };
}

/**
 * Recognize mouse-only strings, including reports with no actionable event
 * such as releases. The paste fallback guard must swallow those too. Mixed
 * strings remain text to avoid losing keystrokes. A literal paste consisting
 * entirely of mouse-shaped tokens is treated as mouse input on that fallback;
 * usePaste listeners receive literal content separately.
 */
export function isMouseSequence(input: string): boolean {
  return SGR_CHUNK.test(input);
}

/**
 * Split mouse-only strings into ordered reports. Mixed or non-mouse input
 * returns [] so it remains keyboard input.
 */
export function splitMouseSequences(input: string): string[] {
  if (!isMouseSequence(input)) return [];
  return input.match(SGR_SPLIT) ?? [];
}

/**
 * Parse a single SGR mouse sequence from the read adapter or paste guard.
 * Returns `null` for non-actionable or malformed reports.
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
  if (cb & 32) return { kind: "move", col, row };
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
}

export type MouseAction =
  | { kind: "none" }
  | { kind: "scroll"; delta: 1 | -1 }
  | { kind: "select"; itemIndex: number; rowIndex: number };

/**
 * Map a 1-based SGR row to a clickable/hoverable tree item, shared by
 * `resolveMouseAction` (press) and `resolveHoverItemIndex` (move) so the two
 * can never disagree about which row a given terminal row hits. Returns
 * `null` for chrome, lifecycle rows (Pending Workspace / Lifecycle Progress Row),
 * and inert rows (pane headers) — the same predicate keyboard navigation
 * uses, so a pointer can't select/hover a row arrow keys refuse.
 */
function hitTestTreeRow(
  row: number,
  ctx: MouseActionContext,
): { itemIndex: number; rowIndex: number } | null {
  if (ctx.mode.type !== "Navigate" && ctx.mode.type !== "Expanded") {
    return null;
  }
  const viewportRow = row - 1 - HEADER_OFFSET;
  if (viewportRow < 0 || viewportRow >= ctx.viewportRows) {
    return null; // header / StatusBar / below the viewport
  }
  const rowIndex = ctx.effectiveScrollOffset + viewportRow;
  const treeRow = ctx.rows[rowIndex];
  const itemIndex = treeRow?.itemIndex;
  if (itemIndex == null) {
    return null; // lifecycle row / padding
  }
  if (isInertTreeItem(ctx.treeItems[itemIndex])) {
    return null;
  }
  return { itemIndex, rowIndex };
}

/**
 * Resolve a parsed mouse event into a pure description of what should happen,
 * testable without React. This tree dispatcher acts only in Navigate and
 * Expanded modes; other modes resolve to `none`. Modal components handle
 * their own mouse events through `useGuardedInput` and `MouseClickable`.
 *
 * - Wheel → scroll only; the selection is untouched and may scroll out of view.
 * - Left-click → hit-test the row under the cursor and select it. Activation
 *   is resolved separately after double-click detection. Non-left buttons and
 *   clicks on chrome, lifecycle rows or inert pane headers are `none`.
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

  if (event.kind === "move") {
    return { kind: "none" };
  }

  if (event.button !== "left") {
    return { kind: "none" };
  }

  const hit = hitTestTreeRow(event.row, ctx);
  if (!hit) {
    return { kind: "none" };
  }

  return { kind: "select", itemIndex: hit.itemIndex, rowIndex: hit.rowIndex };
}

/**
 * The tree-item index currently under the pointer, for hover styling. `null`
 * for anything that isn't a `move` event over a selectable row (chrome,
 * lifecycle rows, inert pane headers, or a mode that doesn't act on mouse).
 */
export function resolveHoverItemIndex(
  event: MouseEvent,
  ctx: MouseActionContext,
): number | null {
  if (event.kind !== "move") return null;
  return hitTestTreeRow(event.row, ctx)?.itemIndex ?? null;
}

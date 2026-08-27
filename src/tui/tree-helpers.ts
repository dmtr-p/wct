// src/tui/tree-helpers.ts

import { basename } from "node:path";
import { formatSessionName } from "../services/tmux";
import { formatSync } from "../services/worktree-service";
import type { RepoInfo } from "./hooks/useRegistry";
import {
  isLifecycleActive,
  type LifecycleEntry,
  type LifecyclePhase,
  type LifecycleState,
  lifecycleEntryFor,
} from "./lifecycle";
import { wrapPrLabel } from "./pr-layout";
import {
  Mode,
  type PaneInfo,
  type PRInfo,
  pendingKey,
  type TreeItem,
} from "./types";

const NO_LIFECYCLE: LifecycleState = new Map();

/**
 * Effective expansion is the OR of the STORED preference and an active
 * lifecycle: a Workspace under a lifecycle is *presented* as expanded without
 * its key ever being written into `expandedWorktreeKeys` (AC-33). Writing the
 * key would be pruned right back out by `reconcileExpandedWorktreeKeys` on the
 * next `repos` change — the 5s poll included — and would also leak a
 * transient operation into a durable user preference.
 */
export function isWorktreeEffectivelyExpanded({
  expandedWorktreeKeys,
  lifecycle = NO_LIFECYCLE,
  project,
  repoPath,
  branch,
}: {
  expandedWorktreeKeys?: Set<string>;
  lifecycle?: LifecycleState;
  project: string;
  repoPath: string;
  branch: string;
}): boolean {
  if (expandedWorktreeKeys?.has(pendingKey(project, branch))) return true;
  return lifecycleEntryFor(lifecycle, repoPath, branch) !== undefined;
}

/**
 * True when a `worktree` tree item's Workspace is under an active lifecycle.
 *
 * The expansion affordances (collapse key, pointer double-click) are refused
 * for such a Workspace: `isWorktreeEffectivelyExpanded` already paints it `▼`
 * via the presentation-only override, so a toggle could not visibly take
 * effect, and the stored-preference write would outlive the operation (AC-9,
 * AC-33).
 */
export function isWorktreeLifecycleActive(
  item: TreeItem,
  repos: RepoInfo[],
  lifecycle: LifecycleState,
): boolean {
  if (item.type !== "worktree") return false;
  const repo = repos[item.repoIndex];
  const worktree = repo?.worktrees[item.worktreeIndex];
  if (!repo || !worktree) return false;
  return isLifecycleActive(lifecycle, repo.repoPath, worktree.branch);
}

interface BuildTreeOptions {
  repos: RepoInfo[];
  expandedWorktreeKeys?: Set<string>;
  /** Active lifecycle operations, keyed by Workspace Identity. */
  lifecycle?: LifecycleState;
  prData: Map<string, PRInfo>;
  panes: Map<string, PaneInfo[]>;
  jumpToPane: (paneId: string) => void;
}

interface BuildTreeRowsOptions {
  items: TreeItem[];
  repos: RepoInfo[];
  /** Repos are always expanded in production; retained for test fixtures. */
  expandedRepos?: Set<string>;
  expandedWorktreeKeys?: Set<string>;
  /** Active lifecycle operations, keyed by Workspace Identity. */
  lifecycle?: LifecycleState;
  /**
   * Terminal width in columns, used to count how many terminal lines a PR
   * detail label wraps onto. Defaults to `Infinity` (no wrapping) so callers
   * and tests that don't model wrapping keep a 1:1 row-per-detail mapping.
   */
  maxWidth?: number;
}

/**
 * A single *visual terminal row*. Logical tree items are not 1:1 with terminal
 * rows: an expanded worktree with stats emits a second row, an expanded repo
 * with zero worktrees emits a `(no worktrees)` row, and the lifecycle rows
 * (`pending-workspace`, `lifecycle-progress`) are not present in `items` at
 * all.
 *
 * `itemIndex` maps each visual row back to its logical item index in `items`
 * (or `null` for secondary rows that are not independently selectable — every
 * lifecycle row is `null`, so neither keyboard navigation nor mouse
 * hit-testing can ever land on one).
 * A wrapped PR's continuation rows carry the PR's own `itemIndex` so a click on
 * any wrapped line still selects the PR.
 * `kind` carries enough information for `TreeView` to render the row directly,
 * so the row model is the single source of truth for both windowing and the
 * render itself.
 */
export type TreeRow =
  | { itemIndex: number; kind: "repo" }
  | { itemIndex: null; kind: "repo-empty"; repoIndex: number }
  | { itemIndex: number; kind: "worktree" }
  | {
      itemIndex: null;
      kind: "worktree-stats";
      repoIndex: number;
      worktreeIndex: number;
    }
  | { itemIndex: number; kind: "detail"; prLine?: string }
  | {
      itemIndex: number;
      kind: "detail-pr-cont";
      pieceIndex: number;
      prLine: string;
    }
  /**
   * A Workspace that an `open` has begun but git does not yet expose as a
   * worktree. Replaces the old `phantom` row kind, keeping its placement rule
   * verbatim.
   */
  | {
      itemIndex: null;
      kind: "pending-workspace";
      repoIndex: number;
      branch: string;
    }
  /** The single progress row for one Workspace under an active lifecycle. */
  | {
      itemIndex: null;
      kind: "lifecycle-progress";
      repoIndex: number;
      branch: string;
      phase: LifecyclePhase;
    }
  | { itemIndex: null; kind: "confirmation"; partIndex: number };

export function insertConfirmationRows(
  rows: TreeRow[],
  anchorItemIndex: number,
  rowCount: number,
): TreeRow[] {
  const anchorRowIndex = rows.findIndex(
    (row) => row.itemIndex === anchorItemIndex,
  );
  if (anchorRowIndex === -1 || rowCount <= 0) return rows;

  const confirmationRows: TreeRow[] = Array.from(
    { length: rowCount },
    (_, partIndex) => ({
      itemIndex: null,
      kind: "confirmation",
      partIndex,
    }),
  );
  return [
    ...rows.slice(0, anchorRowIndex + 1),
    ...confirmationRows,
    ...rows.slice(anchorRowIndex + 1),
  ];
}

export function confirmationRowRange(
  rows: TreeRow[],
): { start: number; end: number } | null {
  const start = rows.findIndex(
    (row) => row.kind === "confirmation" && row.partIndex === 0,
  );
  if (start === -1) return null;

  let end = start;
  while (rows[end + 1]?.kind === "confirmation") end += 1;
  return { start, end };
}

export function scrollRangeToKeepVisible(
  range: { start: number; end: number },
  scrollOffset: number,
  viewportRows: number,
): number {
  if (viewportRows <= 0) return scrollOffset;
  const rangeRows = range.end - range.start + 1;
  if (rangeRows > viewportRows) return range.start;
  if (range.start < scrollOffset) return range.start;
  if (range.end >= scrollOffset + viewportRows) {
    return range.end - viewportRows + 1;
  }
  return scrollOffset;
}

interface ResolveSelectedPaneOptions {
  repos: RepoInfo[];
  items: TreeItem[];
  panes: Map<string, PaneInfo[]>;
  selectedIndex: number;
}

interface SelectedPaneResolution {
  pane: PaneInfo;
  label: string;
  worktreeKey: string;
}

interface ResolveStatusBarPropsOptions {
  mode: Mode;
  items: TreeItem[];
  selectedIndex: number;
  repos?: RepoInfo[];
}

interface ResolveExpandedRightArrowActionOptions {
  repos: RepoInfo[];
  items: TreeItem[];
  selectedIndex: number;
}

interface ResolveRecoveredSelectionIndexOptions {
  prevTree: TreeItem[];
  treeItems: TreeItem[];
  prevSelectionId: string | null;
  /**
   * Identity of the PARENT branch row of the previously selected item, when it
   * was a detail row (see `treeItemParentId`). Used as the deterministic
   * fallback when that detail row itself is gone from the tree.
   */
  prevSelectionParentId?: string | null;
  /**
   * Active lifecycle operations. Required for the `prevSelectionParentId`
   * fallback: it is scoped to detail rows a LIFECYCLE suppressed, so an
   * ordinary disappearance (a killed pane, a PR that closed) still clamps to
   * the adjacent row instead of snapping up to the parent branch.
   */
  lifecycle?: LifecycleState;
  selectedIndex: number;
  repos: RepoInfo[];
  skipIdentityRecovery?: boolean;
}

interface ResolveCloseSelectedWorktreeActionOptions {
  mode: Mode;
  repos: RepoInfo[];
  items: TreeItem[];
  selectedIndex: number;
}

export function resolveConfirmationAnchorItemIndex(
  mode: Mode,
  items: TreeItem[],
  repos: RepoInfo[],
): number | null {
  if (mode.type === "ConfirmKill") {
    const paneIndex = items.findIndex((item) => {
      if (item.type !== "detail" || item.detailKind !== "pane") return false;
      if (item.meta.paneId !== mode.paneId) return false;
      const repo = repos[item.repoIndex];
      const worktree = repo?.worktrees[item.worktreeIndex];
      return (
        repo !== undefined &&
        worktree !== undefined &&
        pendingKey(repo.project, worktree.branch) === mode.worktreeKey
      );
    });
    return paneIndex === -1 ? null : paneIndex;
  }

  if (
    mode.type !== "ConfirmDown" &&
    mode.type !== "ConfirmClose" &&
    mode.type !== "ConfirmCloseForce"
  ) {
    return null;
  }

  const worktreeIndex = items.findIndex((item) => {
    if (item.type !== "worktree") return false;
    const repo = repos[item.repoIndex];
    const worktree = repo?.worktrees[item.worktreeIndex];
    return (
      repo !== undefined &&
      worktree !== undefined &&
      pendingKey(repo.project, worktree.branch) === mode.worktreeKey
    );
  });
  return worktreeIndex === -1 ? null : worktreeIndex;
}

type ExpandedRightArrowAction =
  | { type: "noop" }
  | {
      type: "expand-worktree";
      worktreeKey: string;
      nextSelectedIndex: number;
    };

type CloseSelectedWorktreeAction =
  | { type: "noop" }
  | {
      type: "close-worktree";
      worktreeIndex: number;
      worktreeKey: string;
      nextMode?: Mode;
      nextSelectedIndex?: number;
    };

export interface ResolvedStatusBarProps {
  mode: Mode;
  selectedPaneRow?: boolean;
  /** The project identifier of the repo that the cursor is on or under. */
  selectedProject?: string;
}

export function resolveTreeReturnMode(mode: Mode): Mode {
  return mode.type === "Expanded" ? mode : Mode.Navigate;
}

export function reconcileExpandedWorktreeKeys(
  previous: Set<string>,
  repos: RepoInfo[],
): Set<string> {
  const available = new Set(
    repos.flatMap((repo) =>
      repo.worktrees.map((worktree) =>
        pendingKey(repo.project, worktree.branch),
      ),
    ),
  );
  const uncertainRepoPrefixes = repos
    .filter((repo) => repo.error !== undefined)
    .map((repo) => pendingKey(repo.project, ""));
  const next = new Set(
    [...previous].filter(
      (key) =>
        available.has(key) ||
        uncertainRepoPrefixes.some((prefix) => key.startsWith(prefix)),
    ),
  );
  return next.size === previous.size ? previous : next;
}

export function buildTreeItems({
  repos,
  expandedWorktreeKeys,
  lifecycle = NO_LIFECYCLE,
  prData,
  panes,
  jumpToPane,
}: BuildTreeOptions): TreeItem[] {
  const items: TreeItem[] = [];
  for (let ri = 0; ri < repos.length; ri++) {
    const repo = repos[ri];
    if (!repo) {
      continue;
    }

    items.push({ type: "repo", repoIndex: ri });
    for (let wi = 0; wi < repo.worktrees.length; wi++) {
      items.push({ type: "worktree", repoIndex: ri, worktreeIndex: wi });

      const wt = repo.worktrees[wi];
      if (!wt) continue;
      const wtKey = pendingKey(repo.project, wt.branch);
      // A Workspace under an active lifecycle is PRESENTED as expanded (the
      // ▼ indicator, no stats row) but its PR and pane detail items are
      // suppressed: the progress row is the only thing beneath it, so a phase
      // change can never reshuffle detail rows under the user's cursor.
      if (lifecycleEntryFor(lifecycle, repo.repoPath, wt.branch)) continue;
      const isExpanded = expandedWorktreeKeys?.has(wtKey) ?? false;
      if (!isExpanded) continue;

      const sessionName = formatSessionName(basename(wt.path));

      // PR data for this worktree
      const pr = prData.get(wtKey);
      if (pr) {
        items.push({
          type: "detail",
          repoIndex: ri,
          worktreeIndex: wi,
          detailKind: "pr",
          label: `PR #${pr.number}: ${pr.title} (${pr.state})`,
          meta: { rollupState: pr.rollupState },
          action: () =>
            Bun.spawn(["gh", "pr", "view", "--web", String(pr.number)], {
              cwd: repo.repoPath,
            }),
        });
      }

      // Panes for this worktree
      const sessionPanes = panes.get(sessionName);
      if (sessionPanes && sessionPanes.length > 0) {
        items.push({
          type: "detail",
          repoIndex: ri,
          worktreeIndex: wi,
          detailKind: "pane-header",
          label: `Panes (${sessionPanes.length})`,
        });
        for (const pane of sessionPanes) {
          items.push({
            type: "detail",
            repoIndex: ri,
            worktreeIndex: wi,
            detailKind: "pane",
            label: `${pane.window}:${pane.paneIndex} ${pane.command}`,
            meta: {
              paneId: pane.paneId,
              zoomed: pane.zoomed,
              active: pane.active,
              window: pane.window,
              paneIndex: pane.paneIndex,
              command: pane.command,
            },
            action: () => jumpToPane(pane.paneId),
          });
        }
      }
    }
  }
  return items;
}

/**
 * Pending Workspaces, grouped by REPO INDEX. These are `open` lifecycles whose
 * branch is not (yet) a worktree in `repos`, matched on the main repository
 * path rather than the project display name so two repos sharing a display
 * name cannot borrow each other's pending rows.
 *
 * A lifecycle whose repository is not in `repos` at all — filtered out by the
 * active search, or not yet loaded — contributes no rows anywhere.
 */
function pendingWorkspacesByRepoIndex(
  repos: RepoInfo[],
  lifecycle: LifecycleState,
): Map<number, LifecycleEntry[]> {
  const pending = new Map<number, LifecycleEntry[]>();
  if (lifecycle.size === 0) return pending;
  for (let ri = 0; ri < repos.length; ri++) {
    const repo = repos[ri];
    if (!repo) continue;
    const branches = new Set(repo.worktrees.map((wt) => wt.branch));
    for (const entry of lifecycle.values()) {
      if (entry.operation !== "open") continue;
      if (entry.repoPath !== repo.repoPath) continue;
      if (branches.has(entry.branch)) continue;
      const existing = pending.get(ri) ?? [];
      existing.push(entry);
      pending.set(ri, existing);
    }
  }
  return pending;
}

/**
 * Build the visual-row model — one entry per *terminal row* — from the logical
 * `items` list. This is the shared primitive that drives both windowing (slice
 * by scroll offset) and, in a later slice, hit-testing (click row → item).
 *
 * The row order replicates `TreeView`'s render exactly:
 * - a repo row, optionally followed by a `(no worktrees)` row when expanded
 *   with zero worktrees;
 * - a worktree row, optionally followed by a stats row when expanded with
 *   sync/changed-file stats;
 * - detail rows;
 * - Pending Workspace rows (each immediately followed by its own Lifecycle
 *   Progress Row) for a *populated* repo are emitted after that repo's last
 *   worktree row block;
 * - Pending Workspace rows for *empty* expanded repos are appended at the very
 *   bottom of the whole tree (preserving the long-standing `TreeView`
 *   placement quirk verbatim).
 */
export function buildTreeRows({
  items,
  repos,
  expandedRepos = new Set(repos.map((repo) => repo.id)),
  expandedWorktreeKeys,
  lifecycle = NO_LIFECYCLE,
  maxWidth = Number.POSITIVE_INFINITY,
}: BuildTreeRowsOptions): TreeRow[] {
  const rows: TreeRow[] = [];
  const pendingWorkspaces = pendingWorkspacesByRepoIndex(repos, lifecycle);

  const pushPendingWorkspace = (repoIndex: number, entry: LifecycleEntry) => {
    rows.push({
      itemIndex: null,
      kind: "pending-workspace",
      repoIndex,
      branch: entry.branch,
    });
    rows.push({
      itemIndex: null,
      kind: "lifecycle-progress",
      repoIndex,
      branch: entry.branch,
      phase: entry.phase,
    });
  };

  // Pending Workspace rows for a populated repo follow the repo's LAST
  // row-emitting item — the final worktree row block including any trailing
  // detail rows — so an expanded last worktree cannot swallow them.
  const emitPendingIfRepoBlockEnds = (idx: number, repoIndex: number) => {
    const nextItem = items[idx + 1];
    const isLastItemForRepo =
      !nextItem || nextItem.type === "repo" || nextItem.repoIndex !== repoIndex;
    if (!isLastItemForRepo) return;
    const repoPending = pendingWorkspaces.get(repoIndex);
    if (!repoPending) return;
    for (const entry of repoPending) {
      pushPendingWorkspace(repoIndex, entry);
    }
  };

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (!item) continue;

    const repo = repos[item.repoIndex];
    if (!repo) continue;

    if (item.type === "repo") {
      rows.push({ itemIndex: idx, kind: "repo" });
      if (expandedRepos.has(repo.id) && repo.worktrees.length === 0) {
        rows.push({
          itemIndex: null,
          kind: "repo-empty",
          repoIndex: item.repoIndex,
        });
      }
      continue;
    }

    if (item.type === "detail") {
      // A PR label is shown in full and may wrap onto extra terminal lines.
      // Emit one continuation row per wrapped line (all carrying the PR's own
      // itemIndex) so the row model stays 1:1 with terminal rows and clicks on
      // wrapped text still hit the PR. Each row carries its own wrapped line
      // text (`prLine`), so the render consumes exactly the lines this model
      // counted — the count and the rendered text cannot diverge, and
      // DetailRow never re-wraps. pane/pane-header labels are truncated to a
      // single line, so only PR rows can wrap.
      if (item.detailKind === "pr") {
        const lines = wrapPrLabel(
          item.label,
          maxWidth,
          item.meta.rollupState !== null,
        );
        rows.push({ itemIndex: idx, kind: "detail", prLine: lines[0] ?? "" });
        for (let piece = 1; piece < lines.length; piece++) {
          rows.push({
            itemIndex: idx,
            kind: "detail-pr-cont",
            pieceIndex: piece,
            prLine: lines[piece] ?? "",
          });
        }
      } else {
        rows.push({ itemIndex: idx, kind: "detail" });
      }
      emitPendingIfRepoBlockEnds(idx, item.repoIndex);
      continue;
    }

    // worktree
    const worktreeIndex = item.worktreeIndex;
    const wt = repo.worktrees[worktreeIndex];
    if (!wt) continue;

    rows.push({ itemIndex: idx, kind: "worktree" });

    const wtKey = pendingKey(repo.project, wt.branch);
    const lifecycleEntry = lifecycleEntryFor(
      lifecycle,
      repo.repoPath,
      wt.branch,
    );
    if (lifecycleEntry) {
      // Exactly ONE progress row per Workspace, and it takes the stats row's
      // place: the Workspace's identity line stays put while its status is
      // told on the row beneath it.
      rows.push({
        itemIndex: null,
        kind: "lifecycle-progress",
        repoIndex: item.repoIndex,
        branch: wt.branch,
        phase: lifecycleEntry.phase,
      });
    } else {
      const isExpanded = expandedWorktreeKeys?.has(wtKey) ?? false;
      const sync = formatSync(wt.sync);
      const hasStats = (sync !== "" && sync !== "✓") || wt.changedFiles > 0;
      if (isExpanded && hasStats) {
        rows.push({
          itemIndex: null,
          kind: "worktree-stats",
          repoIndex: item.repoIndex,
          worktreeIndex,
        });
      }
    }

    // Pending Workspace rows follow the repo's last worktree-row block. When
    // detail rows trail this worktree, the detail branch above emits them
    // after the last detail row instead.
    emitPendingIfRepoBlockEnds(idx, item.repoIndex);
  }

  // Pending Workspace rows for expanded repos with no worktrees are appended at
  // the very bottom of the whole tree (a long-standing placement quirk, kept
  // verbatim so this change is presentation-neutral for that case).
  for (let ri = 0; ri < repos.length; ri++) {
    const repo = repos[ri];
    if (!repo) continue;
    if (!expandedRepos.has(repo.id)) continue;
    if (repo.worktrees.length > 0) continue;
    const repoPending = pendingWorkspaces.get(ri);
    if (!repoPending) continue;
    for (const entry of repoPending) {
      pushPendingWorkspace(ri, entry);
    }
  }

  return rows;
}

/**
 * Find the index of the first visual row that maps to the given logical
 * `itemIndex`, or `null` if no row maps to it.
 */
export function firstRowForItem(
  rows: TreeRow[],
  itemIndex: number,
): number | null {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.itemIndex === itemIndex) {
      return i;
    }
  }
  return null;
}

/**
 * Clamp a scroll offset to the valid range `[0, max(0, rowsLength -
 * viewportRows)]`. When the tree fits the viewport the offset is forced to 0.
 */
export function clampScrollOffset(
  offset: number,
  rowsLength: number,
  viewportRows: number,
): number {
  const max = Math.max(0, rowsLength - viewportRows);
  if (offset < 0) return 0;
  if (offset > max) return max;
  return offset;
}

/**
 * Minimally nudge the scroll offset so the visual row at `rowIndex` stays
 * within the window `[offset, offset + viewportRows - 1]`:
 * - if it is above the window, set the offset to that row;
 * - if it is below the window, set `offset = rowIndex - viewportRows + 1`;
 * - otherwise leave the offset unchanged.
 *
 * Nudge only — never re-center.
 */
export function scrollToKeepVisible(
  rowIndex: number,
  offset: number,
  viewportRows: number,
): number {
  if (viewportRows <= 0) return offset;
  if (rowIndex < offset) {
    return rowIndex;
  }
  if (rowIndex > offset + viewportRows - 1) {
    return rowIndex - viewportRows + 1;
  }
  return offset;
}

/**
 * The visual row index of ONE Workspace Identity's Lifecycle Progress Row, or
 * `null` when it has no row at all — its repository filtered out by the active
 * search, or not loaded yet.
 *
 * Rows carry a repo INDEX, so the identity is matched by resolving that index
 * back to its main repository path: two repositories sharing a project display
 * name therefore cannot borrow each other's progress row (AC-27).
 */
export function lifecycleProgressRowIndex(
  rows: TreeRow[],
  repos: RepoInfo[],
  mainRepoPath: string,
  branch: string,
): number | null {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row?.kind !== "lifecycle-progress") continue;
    if (row.branch !== branch) continue;
    if (repos[row.repoIndex]?.repoPath !== mainRepoPath) continue;
    return i;
  }
  return null;
}

/** The one-time viewport reveal for a newly active lifecycle operation. */
export interface LifecycleReveal {
  /** The `lifecycleKey` to mark revealed, so this happens exactly once. */
  key: string;
  /** The offset that makes the progress row visible — minimally adjusted. */
  scrollOffset: number;
}

/**
 * Decide whether a newly active lifecycle operation needs the viewport moved.
 *
 * The FIRST active operation not yet revealed and whose progress row exists in
 * the row model wins; the offset is nudged minimally with
 * `scrollRangeToKeepVisible` (never re-centred) so that row's own visual index
 * is inside the window, and an already-visible operation resolves to the
 * offset it was given — no movement at all (AC-29). An operation with no rows
 * (its repository filtered out by the search) is left unrevealed and moves
 * nothing, so it still gets its one reveal if the filter later clears.
 *
 * Pure and one-shot BY DESIGN: everything that happens after the reveal —
 * later phase events, the validating transition, teardown, pending-to-
 * discovered reconciliation — finds the key already in `revealed` and cannot
 * touch the offset again (AC-30).
 */
export function resolveLifecycleReveal({
  rows,
  repos,
  lifecycle,
  revealed,
  scrollOffset,
  viewportRows,
}: {
  rows: TreeRow[];
  repos: RepoInfo[];
  lifecycle: LifecycleState;
  revealed: ReadonlySet<string>;
  scrollOffset: number;
  viewportRows: number;
}): LifecycleReveal | null {
  for (const [key, entry] of lifecycle) {
    if (revealed.has(key)) continue;
    const rowIndex = lifecycleProgressRowIndex(
      rows,
      repos,
      entry.repoPath,
      entry.branch,
    );
    if (rowIndex === null) continue;
    return {
      key,
      scrollOffset: clampScrollOffset(
        scrollRangeToKeepVisible(
          { start: rowIndex, end: rowIndex },
          scrollOffset,
          viewportRows,
        ),
        rows.length,
        viewportRows,
      ),
    };
  }
  return null;
}

/**
 * Pane headers are inert separators the cursor can never land on. The SINGLE
 * predicate shared by keyboard navigation (`createNavigateTree` skips inert
 * items) and mouse hit-testing (`resolveMouseAction` refuses to select them),
 * so a click can never select a row that follow-up keys treat inconsistently.
 * Add any future inert row kind here, never at the call sites.
 */
export function isInertTreeItem(item: TreeItem | undefined): boolean {
  return item?.type === "detail" && item.detailKind === "pane-header";
}

/**
 * Compute a stable identity string for a tree item using repo id and branch,
 * so selection can be recovered after background refreshes that shift indices.
 */
export function treeItemId(item: TreeItem, repos: RepoInfo[]): string | null {
  const repo = repos[item.repoIndex];
  if (!repo) return null;
  if (item.type === "repo") return `repo:${repo.id}`;
  const wt = repo.worktrees[item.worktreeIndex];
  if (!wt) return null;
  if (item.type === "worktree") return `wt:${repo.id}/${wt.branch}`;
  const base = `detail:${repo.id}/${wt.branch}/${item.detailKind}`;
  if (item.detailKind === "pane" && item.meta.paneId)
    return `${base}/${item.meta.paneId}`;
  return base;
}

/**
 * The identity of a detail row's PARENT branch row (`null` for anything else).
 * Reuses `treeItemId` for the worktree form so the two identity spaces cannot
 * drift apart.
 *
 * Selection recovery needs this because a Workspace's PR and pane detail items
 * are suppressed for the duration of a lifecycle: the selected detail row
 * simply ceases to exist, and the cursor must land on its Workspace rather
 * than wherever the index shift left it.
 */
export function treeItemParentId(
  item: TreeItem,
  repos: RepoInfo[],
): string | null {
  if (item.type !== "detail") return null;
  return treeItemId(
    {
      type: "worktree",
      repoIndex: item.repoIndex,
      worktreeIndex: item.worktreeIndex,
    },
    repos,
  );
}

/**
 * Compute the adjusted selectedIndex after all detail rows are removed from the
 * tree (e.g. when exiting Expanded mode or switching expanded worktree).
 *
 * - If the cursor is on a detail row, snap to its parent worktree.
 * - Otherwise subtract the number of detail rows before the cursor.
 */
export function adjustIndexForDetailCollapse(
  items: TreeItem[],
  selectedIndex: number,
): number {
  const current = items[selectedIndex];

  if (current?.type === "detail") {
    return findOwningWorktreeIndex(items, selectedIndex) ?? 0;
  }

  let detailsBefore = 0;
  for (let i = 0; i < selectedIndex; i++) {
    if (items[i]?.type === "detail") detailsBefore++;
  }
  return selectedIndex - detailsBefore;
}

export function resolveRecoveredSelectionIndex({
  prevTree,
  treeItems,
  prevSelectionId,
  prevSelectionParentId = null,
  lifecycle = NO_LIFECYCLE,
  selectedIndex,
  repos,
  skipIdentityRecovery = false,
}: ResolveRecoveredSelectionIndexOptions): number | null {
  if (prevTree === treeItems || !prevSelectionId || skipIdentityRecovery) {
    return null;
  }

  const currentItem = treeItems[selectedIndex];
  if (currentItem && treeItemId(currentItem, repos) === prevSelectionId) {
    return null;
  }

  for (let i = 0; i < treeItems.length; i++) {
    const candidate = treeItems[i];
    if (candidate && treeItemId(candidate, repos) === prevSelectionId) {
      return i;
    }
  }

  // The selected item is gone. When it was a detail row of a Workspace that is
  // still in the tree AND under an active lifecycle — the case a starting
  // lifecycle creates, since it suppresses that Workspace's PR and pane detail
  // rows — snap to that Workspace's branch row. Deterministic, and it keeps the
  // cursor on the Workspace the user was looking at instead of on whatever row
  // inherited its index (AC-18). The lifecycle condition is what keeps this out
  // of ORDINARY selection recovery: a pane that was killed or a PR that closed
  // still falls through to the clamp below, so the cursor lands on the adjacent
  // sibling row as it always has.
  if (prevSelectionParentId) {
    for (let i = 0; i < treeItems.length; i++) {
      const candidate = treeItems[i];
      if (
        candidate?.type !== "worktree" ||
        treeItemId(candidate, repos) !== prevSelectionParentId
      ) {
        continue;
      }
      const repo = repos[candidate.repoIndex];
      const branch = repo?.worktrees[candidate.worktreeIndex]?.branch;
      if (
        repo &&
        branch &&
        isLifecycleActive(lifecycle, repo.repoPath, branch)
      ) {
        return i;
      }
      break;
    }
  }

  if (treeItems.length === 0) {
    return 0;
  }

  if (selectedIndex >= treeItems.length) {
    return treeItems.length - 1;
  }

  return null;
}

export function resolveSelectedWorktreeIndex(
  items: TreeItem[],
  selectedIndex: number,
): number | null {
  const selected = items[selectedIndex];
  if (!selected) {
    return null;
  }

  if (selected.type === "worktree") {
    return selectedIndex;
  }

  if (selected.type === "detail") {
    return findOwningWorktreeIndex(items, selectedIndex);
  }

  return null;
}

export function resolveCloseSelectedWorktreeAction({
  mode,
  repos,
  items,
  selectedIndex,
}: ResolveCloseSelectedWorktreeActionOptions): CloseSelectedWorktreeAction {
  const worktreeIndex = resolveSelectedWorktreeIndex(items, selectedIndex);
  if (worktreeIndex === null) {
    return { type: "noop" };
  }

  const selectedWorktree = items[worktreeIndex];
  if (selectedWorktree?.type !== "worktree") {
    return { type: "noop" };
  }

  const repo = repos[selectedWorktree.repoIndex];
  const worktree = repo?.worktrees[selectedWorktree.worktreeIndex];
  if (!repo || !worktree) {
    return { type: "noop" };
  }

  const worktreeKey = pendingKey(repo.project, worktree.branch);
  if (
    (mode.type === "Expanded" ||
      mode.type === "ConfirmKill" ||
      mode.type === "ConfirmDown" ||
      mode.type === "ConfirmClose" ||
      mode.type === "ConfirmCloseForce") &&
    mode.worktreeKey === worktreeKey
  ) {
    return {
      type: "close-worktree",
      worktreeIndex,
      worktreeKey,
      nextMode: Mode.Navigate,
      nextSelectedIndex: adjustIndexForDetailCollapse(items, selectedIndex),
    };
  }

  return {
    type: "close-worktree",
    worktreeIndex,
    worktreeKey,
  };
}

export function resolveExpandedRightArrowAction({
  repos,
  items,
  selectedIndex,
}: ResolveExpandedRightArrowActionOptions): ExpandedRightArrowAction {
  const current = items[selectedIndex];
  if (!current) {
    return { type: "noop" };
  }

  const repo = repos[current.repoIndex];
  if (!repo) {
    return { type: "noop" };
  }

  if (current.type !== "worktree") {
    return { type: "noop" };
  }

  const worktree = repo.worktrees[current.worktreeIndex];
  if (!worktree) {
    return { type: "noop" };
  }

  return {
    type: "expand-worktree",
    worktreeKey: pendingKey(repo.project, worktree.branch),
    nextSelectedIndex: selectedIndex,
  };
}

export function findOwningWorktreeIndex(
  items: TreeItem[],
  selectedIndex: number,
): number | null {
  const selected = items[selectedIndex];
  if (!selected) {
    return null;
  }

  if (selected.type === "worktree") {
    return selectedIndex;
  }

  if (selected.type !== "detail") {
    return null;
  }

  for (let i = selectedIndex - 1; i >= 0; i--) {
    const candidate = items[i];
    if (candidate?.type === "worktree") {
      return i;
    }
  }

  return null;
}

export function resolveSelectedPane({
  repos,
  items,
  panes,
  selectedIndex,
}: ResolveSelectedPaneOptions): SelectedPaneResolution | null {
  const selected = items[selectedIndex];
  if (selected?.type !== "detail" || selected.detailKind !== "pane") {
    return null;
  }

  const repo = repos[selected.repoIndex];
  const worktree = repo?.worktrees[selected.worktreeIndex];
  if (!repo || !worktree) {
    return null;
  }

  const sessionName = formatSessionName(basename(worktree.path));
  const sessionPanes = panes.get(sessionName);
  if (!sessionPanes) {
    return null;
  }

  const paneId = selected.meta.paneId;
  if (!paneId) {
    return null;
  }

  const pane = sessionPanes.find((candidate) => candidate.paneId === paneId);

  if (!pane) {
    return null;
  }

  return {
    pane,
    label: selected.label,
    worktreeKey: pendingKey(repo.project, worktree.branch),
  };
}

export function resolveStatusBarProps({
  mode,
  items,
  selectedIndex,
  repos,
}: ResolveStatusBarPropsOptions): ResolvedStatusBarProps {
  const selectedItem = items[selectedIndex];
  const selectedProject =
    selectedItem && repos ? repos[selectedItem.repoIndex]?.project : undefined;

  return {
    mode,
    selectedPaneRow:
      selectedItem?.type === "detail" && selectedItem.detailKind === "pane",
    selectedProject,
  };
}

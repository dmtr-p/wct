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
  lifecycleKey,
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
 * A Workspace under a lifecycle is presented as expanded without its key ever
 * being written into `expandedWorktreeKeys` — that would leak a transient
 * operation into a durable user preference.
 */
export function isWorktreeEffectivelyExpanded({
  expandedWorktreeKeys,
  discoveredWorkspaceKeys,
  lifecycle = NO_LIFECYCLE,
  project,
  repoPath,
  branch,
}: {
  expandedWorktreeKeys?: Set<string>;
  discoveredWorkspaceKeys?: Set<string>;
  lifecycle?: LifecycleState;
  project: string;
  repoPath: string;
  branch: string;
}): boolean {
  if (expandedWorktreeKeys?.has(pendingKey(project, branch))) return true;
  if (discoveredWorkspaceKeys?.has(lifecycleKey(repoPath, branch))) return true;
  return lifecycleEntryFor(lifecycle, repoPath, branch) !== undefined;
}

/**
 * True when a `worktree` tree item's Workspace is under an active lifecycle —
 * its expansion affordances (collapse key, double-click) are refused, since
 * `isWorktreeEffectivelyExpanded` already forces it expanded.
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
  discoveredWorkspaceKeys?: Set<string>;
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
  discoveredWorkspaceKeys?: Set<string>;
  lifecycle?: LifecycleState;
  /** Defaults to `Infinity` so callers that don't model wrapping keep a 1:1 row-per-detail mapping. */
  maxWidth?: number;
}

/**
 * A single visual terminal row. Logical tree items are not 1:1 with terminal
 * rows — a stats row, a `(no worktrees)` row, and the lifecycle rows all have
 * no entry in `items`, so their `itemIndex` is `null` and neither keyboard
 * navigation nor mouse hit-testing can land on them. A wrapped PR's
 * continuation rows carry the PR's own `itemIndex` so a click on any wrapped
 * line still selects the PR.
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
  /** A Workspace that an `open` has begun but git does not yet expose as a worktree. */
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
  /** Parent branch identity of the previously selected detail row (see `treeItemParentId`). */
  prevSelectionParentId?: string | null;
  /**
   * Required for the `prevSelectionParentId` fallback, which only applies
   * when that parent is under an active lifecycle — an ordinary disappearance
   * (a killed pane, a closed PR) still clamps to the adjacent row instead.
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

export function reconcileDiscoveredWorkspaceKeys(
  previous: Set<string>,
  repos: RepoInfo[],
): Set<string> {
  const available = new Set(
    repos.flatMap((repo) =>
      repo.worktrees.map((worktree) =>
        lifecycleKey(repo.repoPath, worktree.branch),
      ),
    ),
  );
  const uncertainRepoPrefixes = repos
    .filter((repo) => repo.error !== undefined)
    .map((repo) => lifecycleKey(repo.repoPath, ""));
  const next = new Set(
    [...previous].filter(
      (key) =>
        available.has(key) ||
        uncertainRepoPrefixes.some((prefix) => key.startsWith(prefix)),
    ),
  );
  return next.size === previous.size ? previous : next;
}

export function workspaceIdentityKeysForDisplayKey(
  repos: RepoInfo[],
  worktreeKey: string,
): Set<string> {
  const identities = new Set<string>();
  for (const repo of repos) {
    for (const worktree of repo.worktrees) {
      if (pendingKey(repo.project, worktree.branch) !== worktreeKey) continue;
      identities.add(lifecycleKey(repo.repoPath, worktree.branch));
    }
  }
  return identities;
}

export function buildTreeItems({
  repos,
  expandedWorktreeKeys,
  discoveredWorkspaceKeys,
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
      // Suppress PR/pane detail items under an active lifecycle, so a phase
      // change can never reshuffle detail rows under the user's cursor.
      if (lifecycleEntryFor(lifecycle, repo.repoPath, wt.branch)) continue;
      const isExpanded = isWorktreeEffectivelyExpanded({
        expandedWorktreeKeys,
        discoveredWorkspaceKeys,
        lifecycle,
        project: repo.project,
        repoPath: repo.repoPath,
        branch: wt.branch,
      });
      if (!isExpanded) continue;

      const sessionName = formatSessionName(basename(wt.path));

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
 * Pending Workspaces, grouped by repo index. These are `open` lifecycles
 * whose branch is not (yet) a worktree in `repos`, matched on the main
 * repository path rather than the project display name so two repos sharing
 * a display name cannot borrow each other's pending rows.
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
 * Build the visual-row model — one entry per terminal row — from the logical
 * `items` list. Row order must replicate `TreeView`'s render exactly: repo,
 * optional no-worktrees row, worktree, optional stats row, detail rows, then
 * each repo's Pending Workspace rows after its last row-emitting item (or at
 * the very bottom of the tree for empty expanded repos).
 */
export function buildTreeRows({
  items,
  repos,
  expandedRepos = new Set(repos.map((repo) => repo.id)),
  expandedWorktreeKeys,
  discoveredWorkspaceKeys,
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
      // Each wrapped PR line becomes its own row carrying the wrapped text
      // (`prLine`), so the render consumes exactly the lines counted here and
      // DetailRow never re-wraps. pane/pane-header labels never wrap.
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

    const worktreeIndex = item.worktreeIndex;
    const wt = repo.worktrees[worktreeIndex];
    if (!wt) continue;

    rows.push({ itemIndex: idx, kind: "worktree" });

    const lifecycleEntry = lifecycleEntryFor(
      lifecycle,
      repo.repoPath,
      wt.branch,
    );
    if (lifecycleEntry) {
      // Takes the stats row's place — one progress row per Workspace.
      rows.push({
        itemIndex: null,
        kind: "lifecycle-progress",
        repoIndex: item.repoIndex,
        branch: wt.branch,
        phase: lifecycleEntry.phase,
      });
    } else {
      const isExpanded = isWorktreeEffectivelyExpanded({
        expandedWorktreeKeys,
        discoveredWorkspaceKeys,
        lifecycle,
        project: repo.project,
        repoPath: repo.repoPath,
        branch: wt.branch,
      });
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

    emitPendingIfRepoBlockEnds(idx, item.repoIndex);
  }

  // Expanded repos with no worktrees get their Pending Workspace rows at the
  // very bottom of the whole tree.
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

/** Nudge only — never re-center. */
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
 * Rows carry a repo index rather than a path, so the identity is matched by
 * resolving that index back to its main repository path — two repositories
 * sharing a project display name therefore cannot borrow each other's
 * progress row.
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
 * The first active operation not yet revealed and whose progress row exists
 * wins; an operation with no row yet (filtered out by the search) is left
 * unrevealed so it still gets its one reveal once the filter clears. One-shot
 * by construction: once a key is in `revealed`, later phase events, teardown,
 * and reconciliation all find it there and never touch the offset again.
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
 * Shared by keyboard navigation and mouse hit-testing, so a click can never
 * select a row that follow-up keys treat inconsistently. Add any future inert
 * row kind here, never at the call sites.
 */
export function isInertTreeItem(item: TreeItem | undefined): boolean {
  return item?.type === "detail" && item.detailKind === "pane-header";
}

/** Stable identity string so selection can be recovered after a refresh shifts indices. */
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
 * A detail row's parent branch identity (`null` for anything else). Selection
 * recovery needs this because a lifecycle suppresses a Workspace's detail
 * rows, so the selected row can vanish and the cursor must land on its
 * Workspace instead of wherever the index shift left it.
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

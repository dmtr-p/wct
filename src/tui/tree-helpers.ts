import { basename } from "node:path";
import type { AgentObservation } from "../services/agent-model";
import type { WorkspaceIdentityKey } from "../services/identities";
import type { WorkspacePrEntry } from "../services/pr-cache-service";
import { type PrFacts, prIdentity } from "../services/pr-model";
import { formatSessionName } from "../services/tmux";
import { formatSync } from "../services/worktree-service";
import type { RepoInfo } from "./hooks/useRegistry";
import {
  isLifecycleActive,
  type LifecycleEntry,
  lifecycleEntryFor,
  type LifecyclePhase,
  type LifecycleState,
  workspaceIdentityKey,
} from "./lifecycle";
import { wrapPrTitle } from "./pr-layout";
import { candidatePrLabel, derivePrPresentation } from "./pr-status";
import { Mode, type PaneInfo, type TreeItem } from "./types";

const NO_LIFECYCLE: LifecycleState = new Map();

export function openPrInBrowser(
  repoPath: string,
  number: number,
  url?: string,
): void {
  Bun.spawn(["gh", "pr", "view", "--web", url || String(number)], {
    cwd: repoPath,
  });
}

export function prExpansionKey(
  workspaceKey: WorkspaceIdentityKey,
  pr: PrFacts,
): string {
  return `${workspaceKey}\0${prIdentity(pr)}`;
}

/**
 * Lifecycle expansion must not change the user's stored expansion preference.
 */
export function isWorktreeEffectivelyExpanded({
  expandedWorkspaceKeys,
  lifecycle = NO_LIFECYCLE,
  repoPath,
  branch,
}: {
  expandedWorkspaceKeys?: Set<WorkspaceIdentityKey>;
  lifecycle?: LifecycleState;
  repoPath: string;
  branch: string;
}): boolean {
  if (expandedWorkspaceKeys?.has(workspaceIdentityKey(repoPath, branch)))
    return true;
  return lifecycleEntryFor(lifecycle, repoPath, branch) !== undefined;
}

/**
 * Active lifecycles force expansion, so collapse and double-click are refused.
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
  agents?: Map<string, AgentObservation>;
  repos: RepoInfo[];
  expandedWorkspaceKeys?: Set<WorkspaceIdentityKey>;
  lifecycle?: LifecycleState;
  prData: Map<WorkspaceIdentityKey, PrFacts>;
  associations?: Map<WorkspaceIdentityKey, WorkspacePrEntry>;
  expandedPrKeys?: Set<string>;
  panes: Map<string, PaneInfo[]>;
  jumpToPane: (paneId: string) => void;
}

interface BuildTreeRowsOptions {
  items: TreeItem[];
  repos: RepoInfo[];
  expandedWorkspaceKeys?: Set<WorkspaceIdentityKey>;
  lifecycle?: LifecycleState;
  /** Defaults to `Infinity` so callers that don't model wrapping keep a 1:1 row-per-detail mapping. */
  maxWidth?: number;
}

/**
 * Null item indices make visual-only rows unselectable. Wrapped PR lines
 * share their PR's item index so clicking any continuation selects the PR.
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
  /** A Pending Workspace, before Git exposes its worktree during `open`. */
  | {
      itemIndex: null;
      kind: "pending-workspace";
      repoIndex: number;
      branch: string;
    }
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
  workspaceKey: WorkspaceIdentityKey;
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
  /** Parent item identity of the previously selected detail row. */
  prevSelectionParentId?: string | null;
  /**
   * Pane recovery falls back to the worktree only during an active lifecycle;
   * an ordinary pane disappearance clamps to the adjacent row. PR and candidate
   * details can recover to their enclosing items without an active lifecycle.
   */
  lifecycle?: LifecycleState;
  selectedIndex: number;
  repos: RepoInfo[];
  skipIdentityRecovery?: boolean;
}

export function resolveConfirmationAnchorItemIndex(
  mode: Mode,
  items: TreeItem[],
  repos: RepoInfo[],
): number | null {
  if (mode.type === "ConfirmRemoveProject") {
    const repoIndex = items.findIndex((item) => {
      if (item.type !== "repo") return false;
      return repos[item.repoIndex]?.repoPath === mode.repoPath;
    });
    return repoIndex === -1 ? null : repoIndex;
  }

  if (mode.type === "ConfirmKill") {
    const paneIndex = items.findIndex((item) => {
      if (item.type !== "detail" || item.detailKind !== "pane") return false;
      if (item.meta.paneId !== mode.paneId) return false;
      const repo = repos[item.repoIndex];
      const worktree = repo?.worktrees[item.worktreeIndex];
      return (
        repo !== undefined &&
        worktree !== undefined &&
        workspaceIdentityKey(repo.repoPath, worktree.branch) ===
          mode.workspaceKey
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
      workspaceIdentityKey(repo.repoPath, worktree.branch) === mode.workspaceKey
    );
  });
  return worktreeIndex === -1 ? null : worktreeIndex;
}

type ExpandedRightArrowAction =
  | { type: "noop" }
  | {
      type: "expand-worktree";
      workspaceKey: WorkspaceIdentityKey;
      nextSelectedIndex: number;
    };

export interface ResolvedStatusBarProps {
  mode: Mode;
  selectedPaneRow?: boolean;
  selectedProject?: string;
}

export function resolveTreeReturnMode(mode: Mode): Mode {
  return mode.type === "Expanded" ? mode : Mode.Navigate;
}

export function reconcileExpandedWorkspaceKeys(
  previous: Set<WorkspaceIdentityKey>,
  repos: RepoInfo[],
): Set<WorkspaceIdentityKey> {
  const available = new Set<WorkspaceIdentityKey>(
    repos.flatMap((repo) =>
      repo.worktrees.map((worktree) =>
        workspaceIdentityKey(repo.repoPath, worktree.branch),
      ),
    ),
  );
  const uncertainRepoPrefixes = repos
    .filter((repo) => repo.error !== undefined)
    .map((repo) => workspaceIdentityKey(repo.repoPath, ""));
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
  expandedWorkspaceKeys,
  lifecycle = NO_LIFECYCLE,
  prData,
  associations,
  expandedPrKeys,
  panes,
  agents,
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
      // Suppress PR/pane detail items under an active lifecycle, so a phase
      // change can never reshuffle detail rows under the user's cursor.
      if (lifecycleEntryFor(lifecycle, repo.repoPath, wt.branch)) continue;
      const isExpanded = isWorktreeEffectivelyExpanded({
        expandedWorkspaceKeys,
        lifecycle,
        repoPath: repo.repoPath,
        branch: wt.branch,
      });
      if (!isExpanded) continue;

      const sessionName = formatSessionName(basename(wt.path));

      const workspaceKey = workspaceIdentityKey(repo.repoPath, wt.branch);
      const association = associations?.get(workspaceKey);
      const pr = prData.get(workspaceKey);
      if (pr) {
        const prKey = prExpansionKey(workspaceKey, pr);
        const presentation = derivePrPresentation(pr);
        const expanded = expandedPrKeys?.has(prKey) ?? false;
        const openUrl = () => openPrInBrowser(repo.repoPath, pr.number, pr.url);
        items.push({
          type: "detail",
          repoIndex: ri,
          worktreeIndex: wi,
          detailKind: "pr",
          label: `#${pr.number} ${presentation.primary}`,
          meta: {
            prKey,
            presentation,
            pr,
            expanded,
          },
          action: openUrl,
        });
        if (expanded) {
          for (const detail of presentation.details) {
            items.push({
              type: "detail",
              repoIndex: ri,
              worktreeIndex: wi,
              detailKind: detail.key === "title" ? "pr-title" : "pr-fact",
              label: detail.text,
              meta:
                detail.key === "title"
                  ? { prKey }
                  : { prKey, factKey: detail.key },
              action: openUrl,
            } as TreeItem);
          }
          if (association?.newerOpenPr)
            items.push({
              type: "detail",
              repoIndex: ri,
              worktreeIndex: wi,
              detailKind: "pr-fact",
              label: `Newer open PR: #${association.newerOpenPr}`,
              meta: { prKey, factKey: "newer" },
              action: openUrl,
            });
        }
      } else if (association?.candidates.length) {
        const groupKey = `${workspaceKey}\0candidates`;
        const expanded = expandedPrKeys?.has(groupKey) ?? false;
        items.push({
          type: "detail",
          repoIndex: ri,
          worktreeIndex: wi,
          detailKind: "candidate-group",
          label: `${association.candidates.length} candidate PR${association.candidates.length === 1 ? "" : "s"}`,
          meta: { groupKey, expanded },
        });
        if (expanded)
          for (const candidate of association.candidates) {
            items.push({
              type: "detail",
              repoIndex: ri,
              worktreeIndex: wi,
              detailKind: "candidate",
              label: candidatePrLabel(candidate),
              meta: { groupKey, pr: candidate },
              action: candidate.url
                ? () =>
                    openPrInBrowser(
                      repo.repoPath,
                      candidate.number,
                      candidate.url,
                    )
                : undefined,
            });
          }
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
              agent: agents?.get(pane.paneId),
            },
            action: () => jumpToPane(pane.paneId),
          });
        }
      }
    }
  }
  return items;
}

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
 * Each entry must occupy one terminal row in TreeView, including wrapped PR
 * text and lifecycle rows, so viewport slicing and mouse hit-testing agree.
 */
export function buildTreeRows({
  items,
  repos,
  expandedWorkspaceKeys,
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
      if (repo.worktrees.length === 0) {
        rows.push({
          itemIndex: null,
          kind: "repo-empty",
          repoIndex: item.repoIndex,
        });
      }
      continue;
    }

    if (item.type === "detail") {
      // Share wrapped text with DetailRow so rendering cannot change the row count.
      if (item.detailKind === "pr-title") {
        const lines = wrapPrTitle(item.label, maxWidth);
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
        expandedWorkspaceKeys,
        lifecycle,
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

  // Repos with no worktrees get their Pending Workspace rows at the
  // very bottom of the whole tree.
  for (let ri = 0; ri < repos.length; ri++) {
    const repo = repos[ri];
    if (!repo) continue;
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

export interface LifecycleReveal {
  /** The `workspaceIdentityKey` to mark revealed, so this happens exactly once. */
  key: WorkspaceIdentityKey;
  scrollOffset: number;
}

/**
 * Leave filtered-out operations unrevealed until their rows exist. Recording
 * returned keys in `revealed` prevents later phase events from moving the viewport.
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
  revealed: ReadonlySet<WorkspaceIdentityKey>;
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
 * Keep inert row kinds here so keyboard and mouse selection use the same rules.
 */
export function isInertTreeItem(item: TreeItem | undefined): boolean {
  return item?.type === "detail" && item.detailKind === "pane-header";
}

function prTreeItemId(repoId: string, branch: string, prKey: string): string {
  return `detail:${repoId}/${branch}/pr/${prKey}`;
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
  if (item.detailKind === "pr")
    return prTreeItemId(repo.id, wt.branch, item.meta.prKey);
  if (item.detailKind === "pr-title" || item.detailKind === "pr-fact")
    return `${base}/${item.meta.prKey}${item.detailKind === "pr-fact" ? `/${item.meta.factKey}` : ""}`;
  if (item.detailKind === "candidate-group")
    return `${base}/${item.meta.groupKey}`;
  if (item.detailKind === "candidate")
    return `${base}/${item.meta.groupKey}/${item.meta.pr.number}`;
  if (item.detailKind === "pane" && item.meta.paneId)
    return `${base}/${item.meta.paneId}`;
  return base;
}

/**
 * Return the enclosing PR, candidate group, or worktree identity for detail
 * rows. Recovery uses it when collapsing details or starting a lifecycle hides
 * the selected row; other item kinds have no parent fallback.
 */
export function treeItemParentId(
  item: TreeItem,
  repos: RepoInfo[],
): string | null {
  if (item.type !== "detail") return null;
  if (item.detailKind === "pr-title" || item.detailKind === "pr-fact") {
    const repo = repos[item.repoIndex];
    const wt = repo?.worktrees[item.worktreeIndex];
    return repo && wt
      ? prTreeItemId(repo.id, wt.branch, item.meta.prKey)
      : null;
  }
  if (item.detailKind === "candidate") {
    return treeItemId(
      {
        type: "detail",
        repoIndex: item.repoIndex,
        worktreeIndex: item.worktreeIndex,
        detailKind: "candidate-group",
        label: "",
        meta: { groupKey: item.meta.groupKey, expanded: false },
      },
      repos,
    );
  }
  return treeItemId(
    {
      type: "worktree",
      repoIndex: item.repoIndex,
      worktreeIndex: item.worktreeIndex,
    },
    repos,
  );
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
    const oldIndex = prevTree.findIndex(
      (candidate) => treeItemId(candidate, repos) === prevSelectionId,
    );
    const previousItem = prevTree[oldIndex];
    const previousDetailKind =
      previousItem?.type === "detail" ? previousItem.detailKind : null;
    const parentIndex = treeItems.findIndex(
      (candidate) => treeItemId(candidate, repos) === prevSelectionParentId,
    );
    if (
      parentIndex >= 0 &&
      (previousDetailKind === "pr-title" ||
        previousDetailKind === "pr-fact" ||
        previousDetailKind === "candidate")
    )
      return parentIndex;
    if (
      previousDetailKind === "pr" ||
      previousDetailKind === "candidate-group" ||
      previousDetailKind === "candidate" ||
      previousDetailKind === "pr-title" ||
      previousDetailKind === "pr-fact"
    ) {
      const oldOwner =
        oldIndex < 0 ? null : findOwningWorktreeIndex(prevTree, oldIndex);
      const oldWorktree = oldOwner === null ? undefined : prevTree[oldOwner];
      const worktreeId = oldWorktree ? treeItemId(oldWorktree, repos) : null;
      const currentOwner = treeItems.findIndex(
        (candidate) =>
          candidate.type === "worktree" &&
          treeItemId(candidate, repos) === worktreeId,
      );
      if (currentOwner >= 0) {
        if (
          previousDetailKind === "candidate" ||
          previousDetailKind === "candidate-group"
        ) {
          const next = treeItems[currentOwner + 1];
          if (next?.type === "detail" && next.detailKind === "pr")
            return currentOwner + 1;
        }
        return currentOwner;
      }
    }
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
    workspaceKey: workspaceIdentityKey(repo.repoPath, worktree.branch),
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
    workspaceKey: workspaceIdentityKey(repo.repoPath, worktree.branch),
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

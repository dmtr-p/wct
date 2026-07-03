import { basename } from "node:path";
import { Box } from "ink";
import { useMemo } from "react";
import { formatSessionName } from "../../services/tmux";
import { formatSync } from "../../services/worktree-service";
import type { RepoInfo } from "../hooks/useRegistry";
import { buildTreeRows, type TreeRow } from "../tree-helpers";
import {
  type PaneInfo,
  type PendingAction,
  type PRInfo,
  pendingKey,
  type TreeItem,
} from "../types";
import { DetailRow } from "./DetailRow";
import { RepoEmptyRow } from "./RepoEmptyRow";
import { RepoNode } from "./RepoNode";
import { WorktreeItem } from "./WorktreeItem";
import { WorktreeStatsRow } from "./WorktreeStatsRow";

interface Props {
  repos: RepoInfo[];
  sessions: Array<{ name: string; attached: boolean }>;
  expandedRepos: Set<string>;
  selectedIndex: number;
  items: TreeItem[];
  pendingActions: Map<string, PendingAction>;
  prData: Map<string, PRInfo>;
  panes: Map<string, PaneInfo[]>;
  expandedWorktreeKey: string | null;
  maxWidth: number;
  refreshingProjects?: Set<string>;
  errors?: Map<string, string>;
  /** First visual row to render. Defaults to 0 (no scrolling). */
  scrollOffset?: number;
  /** Number of visual rows to render. Defaults to rendering all rows. */
  viewportRows?: number;
}

export function getDetailRowKey(
  repoId: string,
  item: Extract<TreeItem, { type: "detail" }>,
): string {
  const base = `detail-${repoId}-${item.worktreeIndex}-${item.detailKind}`;
  if (item.detailKind === "pane") {
    return `${base}-${item.meta.paneId}`;
  }
  return `${base}-${item.label}`;
}

export function TreeView({
  repos,
  sessions,
  expandedRepos,
  selectedIndex,
  items,
  pendingActions,
  prData,
  panes,
  expandedWorktreeKey,
  maxWidth,
  refreshingProjects,
  errors,
  scrollOffset = 0,
  viewportRows,
}: Props) {
  const sessionMap = useMemo(
    () => new Map(sessions.map((s) => [s.name, s])),
    [sessions],
  );

  const rows = useMemo(
    () =>
      buildTreeRows({
        items,
        repos,
        expandedRepos,
        expandedWorktreeKey,
        pendingActions,
        maxWidth,
      }),
    [
      items,
      repos,
      expandedRepos,
      expandedWorktreeKey,
      pendingActions,
      maxWidth,
    ],
  );

  const selectedItem = items[selectedIndex];

  const visibleRows =
    viewportRows === undefined
      ? rows
      : rows.slice(scrollOffset, scrollOffset + viewportRows);

  const elements: React.ReactNode[] = [];

  for (let i = 0; i < visibleRows.length; i++) {
    const row = visibleRows[i];
    if (!row) continue;
    const element = renderRow(row, {
      repos,
      items,
      selectedIndex,
      selectedItem,
      expandedRepos,
      expandedWorktreeKey,
      sessionMap,
      prData,
      panes,
      pendingActions,
      maxWidth,
      refreshingProjects,
      errors,
    });
    if (element) elements.push(element);
  }

  return <Box flexDirection="column">{elements}</Box>;
}

interface RenderRowContext {
  repos: RepoInfo[];
  items: TreeItem[];
  selectedIndex: number;
  selectedItem: TreeItem | undefined;
  expandedRepos: Set<string>;
  expandedWorktreeKey: string | null;
  sessionMap: Map<string, { name: string; attached: boolean }>;
  prData: Map<string, PRInfo>;
  panes: Map<string, PaneInfo[]>;
  pendingActions: Map<string, PendingAction>;
  maxWidth: number;
  refreshingProjects?: Set<string>;
  errors?: Map<string, string>;
}

function renderRow(row: TreeRow, ctx: RenderRowContext): React.ReactNode {
  switch (row.kind) {
    case "repo-empty":
      return <RepoEmptyRow key={`repo-empty-${row.repoIndex}`} />;
    case "phantom": {
      const repo = ctx.repos[row.repoIndex];
      if (!repo) return null;
      return (
        <WorktreeItem
          key={`phantom-${repo.id}-${row.branch}`}
          branch={row.branch}
          hasSession={false}
          isAttached={false}
          isSelected={false}
          pendingStatus="opening"
          maxWidth={ctx.maxWidth}
        />
      );
    }
    case "worktree-stats": {
      const repo = ctx.repos[row.repoIndex];
      const wt = repo?.worktrees[row.worktreeIndex];
      if (!repo || !wt) return null;
      return (
        <WorktreeStatsRow
          key={`wt-stats-${repo.id}-${wt.branch}`}
          sync={formatSync(wt.sync)}
          changedFiles={wt.changedFiles}
        />
      );
    }
    case "repo":
      return renderRepoRow(row.itemIndex, ctx);
    case "worktree":
      return renderWorktreeRow(row.itemIndex, ctx);
    case "detail":
      return renderDetailRow(row.itemIndex, ctx, 0);
    case "detail-pr-cont":
      return renderDetailRow(row.itemIndex, ctx, row.pieceIndex);
  }
}

function renderRepoRow(idx: number, ctx: RenderRowContext): React.ReactNode {
  const item = ctx.items[idx];
  if (item?.type !== "repo") return null;
  const repo = ctx.repos[item.repoIndex];
  if (!repo) return null;

  const childSelected =
    idx !== ctx.selectedIndex &&
    !!ctx.selectedItem &&
    ctx.selectedItem.type !== "repo" &&
    ctx.selectedItem.repoIndex === item.repoIndex;

  return (
    <RepoNode
      key={`repo-${repo.id}`}
      project={repo.project}
      expanded={ctx.expandedRepos.has(repo.id)}
      isSelected={idx === ctx.selectedIndex}
      isChildSelected={childSelected}
      maxWidth={ctx.maxWidth}
      isRefreshing={ctx.refreshingProjects?.has(repo.project)}
      hasError={ctx.errors?.has(repo.project)}
    />
  );
}

function renderWorktreeRow(
  idx: number,
  ctx: RenderRowContext,
): React.ReactNode {
  const item = ctx.items[idx];
  if (item?.type !== "worktree") return null;
  const repo = ctx.repos[item.repoIndex];
  if (!repo) return null;

  const wt = repo.worktrees[item.worktreeIndex];
  if (!wt) return null;

  const sessionName = formatSessionName(basename(wt.path));
  const session = ctx.sessionMap.get(sessionName);
  const wtKey = pendingKey(repo.project, wt.branch);
  const pending = ctx.pendingActions.get(wtKey);

  const wtPr = ctx.prData.get(wtKey);
  const wtPanes = ctx.panes.get(sessionName);
  const hasExpandableData = !!wtPr || (wtPanes && wtPanes.length > 0);

  const wtChildSelected =
    idx !== ctx.selectedIndex &&
    !!ctx.selectedItem &&
    ctx.selectedItem.type === "detail" &&
    ctx.selectedItem.repoIndex === item.repoIndex &&
    ctx.selectedItem.worktreeIndex === item.worktreeIndex;

  return (
    <WorktreeItem
      key={`wt-${repo.id}-${wt.branch}`}
      branch={wt.branch}
      hasSession={!!session}
      isAttached={session?.attached ?? false}
      isSelected={idx === ctx.selectedIndex}
      isChildSelected={wtChildSelected}
      pendingStatus={pending?.type}
      isExpanded={ctx.expandedWorktreeKey === wtKey}
      hasExpandableData={!!hasExpandableData}
      maxWidth={ctx.maxWidth}
    />
  );
}

function renderDetailRow(
  idx: number,
  ctx: RenderRowContext,
  pieceIndex: number,
): React.ReactNode {
  const item = ctx.items[idx];
  if (item?.type !== "detail") return null;
  const repo = ctx.repos[item.repoIndex];
  if (!repo) return null;

  return (
    <DetailRow
      key={
        pieceIndex > 0
          ? `${getDetailRowKey(repo.id, item)}-cont-${pieceIndex}`
          : getDetailRowKey(repo.id, item)
      }
      item={item}
      isSelected={idx === ctx.selectedIndex}
      maxWidth={ctx.maxWidth}
      pieceIndex={pieceIndex}
    />
  );
}

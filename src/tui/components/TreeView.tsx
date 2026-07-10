import { basename } from "node:path";
import { Box } from "ink";
import { useMemo } from "react";
import { formatSessionName } from "../../services/tmux";
import { formatSync } from "../../services/worktree-service";
import type { RepoInfo } from "../hooks/useRegistry";
import {
  type PaneInfo,
  type PendingAction,
  type PRInfo,
  pendingKey,
  type TreeItem,
} from "../types";
import { DetailRow } from "./DetailRow";
import { RepoNode } from "./RepoNode";
import { WorktreeItem } from "./WorktreeItem";

interface Props {
  repos: RepoInfo[];
  sessions: Array<{ name: string; attached: boolean }>;
  selectedIndex: number;
  items: TreeItem[];
  pendingActions: Map<string, PendingAction>;
  prData: Map<string, PRInfo>;
  panes: Map<string, PaneInfo[]>;
  expandedWorktreeKeys: Set<string>;
  maxWidth: number;
  renderedRows?: Array<number | null>;
  scrollOffset?: number;
  viewportHeight?: number;
  refreshingProjects?: Set<string>;
  errors?: Map<string, string>;
}

interface TreeElementWindowEntry {
  elementIndex: number;
  hiddenTop: number;
  height: number;
}

export function getTreeElementHeights(
  renderedRows: Array<number | null>,
): number[] {
  const heights: number[] = [];
  let previousItem: number | null | undefined;

  for (const itemIndex of renderedRows) {
    if (
      itemIndex !== null &&
      itemIndex === previousItem &&
      heights.length > 0
    ) {
      const lastIndex = heights.length - 1;
      heights[lastIndex] = (heights[lastIndex] ?? 0) + 1;
    } else {
      heights.push(1);
    }
    previousItem = itemIndex;
  }

  return heights;
}

export function getTreeElementWindow(
  elementHeights: number[],
  scrollOffset: number,
  viewportHeight: number,
): TreeElementWindowEntry[] {
  const windowStart = Math.max(0, scrollOffset);
  const windowEnd = windowStart + Math.max(0, viewportHeight);
  const visible: TreeElementWindowEntry[] = [];
  let elementStart = 0;

  for (
    let elementIndex = 0;
    elementIndex < elementHeights.length;
    elementIndex++
  ) {
    const elementHeight = elementHeights[elementIndex] ?? 0;
    const elementEnd = elementStart + elementHeight;
    const visibleStart = Math.max(elementStart, windowStart);
    const visibleEnd = Math.min(elementEnd, windowEnd);

    if (visibleStart < visibleEnd) {
      visible.push({
        elementIndex,
        hiddenTop: visibleStart - elementStart,
        height: visibleEnd - visibleStart,
      });
    }

    elementStart = elementEnd;
    if (elementStart >= windowEnd) break;
  }

  return visible;
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
  selectedIndex,
  items,
  pendingActions,
  prData,
  panes,
  expandedWorktreeKeys,
  maxWidth,
  renderedRows,
  scrollOffset = 0,
  viewportHeight = Number.POSITIVE_INFINITY,
  refreshingProjects,
  errors,
}: Props) {
  const sessionMap = useMemo(
    () => new Map(sessions.map((s) => [s.name, s])),
    [sessions],
  );

  const { phantomsByProject } = useMemo(() => {
    const keys = new Set<string>();
    for (const repo of repos) {
      for (const wt of repo.worktrees) {
        keys.add(pendingKey(repo.project, wt.branch));
      }
    }
    const phantoms = new Map<string, PendingAction[]>();
    for (const [key, action] of pendingActions) {
      if (action.type === "opening" && !keys.has(key)) {
        const existing = phantoms.get(action.project) ?? [];
        existing.push(action);
        phantoms.set(action.project, existing);
      }
    }
    return { phantomsByProject: phantoms };
  }, [repos, pendingActions]);

  const elements: React.ReactElement[] = [];
  const selectedItem = items[selectedIndex];

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (!item) continue;

    const repo = repos[item.repoIndex];
    if (!repo) continue;

    if (item.type === "repo") {
      const childSelected =
        idx !== selectedIndex &&
        !!selectedItem &&
        selectedItem.type !== "repo" &&
        selectedItem.repoIndex === item.repoIndex;

      elements.push(
        <RepoNode
          key={`repo-${repo.id}`}
          project={repo.project}
          isSelected={idx === selectedIndex}
          isChildSelected={childSelected}
          worktreeCount={repo.worktrees.length}
          maxWidth={maxWidth}
          isRefreshing={refreshingProjects?.has(repo.project)}
          hasError={errors?.has(repo.project)}
        />,
      );
      continue;
    }

    if (item.type === "detail") {
      elements.push(
        <DetailRow
          key={getDetailRowKey(repo.id, item)}
          item={item}
          isSelected={idx === selectedIndex}
          maxWidth={maxWidth}
        />,
      );
      continue;
    }

    const worktreeIndex = item.worktreeIndex;
    if (worktreeIndex === undefined) continue;

    const wt = repo.worktrees[worktreeIndex];
    if (!wt) continue;

    const sessionName = formatSessionName(basename(wt.path));
    const session = sessionMap.get(sessionName);
    const wtKey = pendingKey(repo.project, wt.branch);
    const pending = pendingActions.get(wtKey);

    const wtPr = prData.get(wtKey);
    const wtPanes = panes.get(sessionName);
    const hasExpandableData = !!wtPr || (wtPanes && wtPanes.length > 0);

    const wtChildSelected =
      idx !== selectedIndex &&
      !!selectedItem &&
      selectedItem.type === "detail" &&
      selectedItem.repoIndex === item.repoIndex &&
      selectedItem.worktreeIndex === worktreeIndex;

    elements.push(
      <WorktreeItem
        key={`wt-${repo.id}-${wt.branch}`}
        branch={wt.branch}
        hasSession={!!session}
        isAttached={session?.attached ?? false}
        sync={formatSync(wt.sync)}
        changedFiles={wt.changedFiles}
        isSelected={idx === selectedIndex}
        isChildSelected={wtChildSelected}
        pendingStatus={pending?.type}
        isExpanded={expandedWorktreeKeys.has(wtKey)}
        hasExpandableData={!!hasExpandableData}
        maxWidth={maxWidth}
      />,
    );

    const nextItem = items[idx + 1];
    const isLastWorktreeForRepo =
      !nextItem ||
      nextItem.type === "repo" ||
      nextItem.repoIndex !== item.repoIndex;

    if (isLastWorktreeForRepo) {
      const phantoms = phantomsByProject.get(repo.project);
      if (phantoms) {
        for (const phantom of phantoms) {
          elements.push(
            <WorktreeItem
              key={`phantom-${repo.id}-${phantom.branch}`}
              branch={phantom.branch}
              hasSession={false}
              isAttached={false}
              sync=""
              changedFiles={0}
              isSelected={false}
              pendingStatus="opening"
              maxWidth={maxWidth}
            />,
          );
        }
      }
    }
  }

  // Phantoms for repos with no worktrees
  for (const repo of repos) {
    if (repo.worktrees.length > 0) continue;
    const phantoms = phantomsByProject.get(repo.project);
    if (!phantoms) continue;
    for (const phantom of phantoms) {
      elements.push(
        <WorktreeItem
          key={`phantom-${repo.id}-${phantom.branch}`}
          branch={phantom.branch}
          hasSession={false}
          isAttached={false}
          sync=""
          changedFiles={0}
          isSelected={false}
          pendingStatus="opening"
          maxWidth={maxWidth}
        />,
      );
    }
  }

  const elementHeights = renderedRows
    ? getTreeElementHeights(renderedRows)
    : elements.map(() => 1);
  const visibleElements = getTreeElementWindow(
    elementHeights,
    scrollOffset,
    viewportHeight,
  ).flatMap(({ elementIndex, hiddenTop, height }) => {
    const element = elements[elementIndex];
    if (!element) return [];

    const elementHeight = elementHeights[elementIndex] ?? 1;
    if (hiddenTop === 0 && height === elementHeight) return [element];

    return [
      <Box
        key={`viewport-${String(element.key ?? elementIndex)}`}
        flexDirection="column"
        height={height}
        flexShrink={0}
        overflowY="hidden"
      >
        <Box flexDirection="column" position="relative" top={-hiddenTop}>
          {element}
        </Box>
      </Box>,
    ];
  });

  return <Box flexDirection="column">{visibleElements}</Box>;
}

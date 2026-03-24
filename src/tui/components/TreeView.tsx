import { basename } from "node:path";
import { Box } from "ink";
import { useMemo } from "react";
import type { QueueItem } from "../../services/queue-storage";
import { formatSessionName } from "../../services/tmux";
import { formatSync } from "../../services/worktree-status";
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
  queueItems: QueueItem[];
  expandedRepos: Set<string>;
  selectedIndex: number;
  items: TreeItem[];
  pendingActions: Map<string, PendingAction>;
  prData: Map<string, PRInfo>;
  panes: Map<string, PaneInfo[]>;
  expandedWorktreeKey: string | null;
}

export function TreeView({
  repos,
  sessions,
  queueItems,
  expandedRepos,
  selectedIndex,
  items,
  pendingActions,
  prData,
  panes,
  expandedWorktreeKey,
}: Props) {
  const sessionMap = useMemo(
    () => new Map(sessions.map((s) => [s.name, s])),
    [sessions],
  );

  const notifCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of queueItems) {
      const key = pendingKey(item.project, item.branch);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [queueItems]);

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

  const elements: React.ReactNode[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (!item) continue;

    const repo = repos[item.repoIndex];
    if (!repo) continue;

    if (item.type === "repo") {
      elements.push(
        <RepoNode
          key={`repo-${repo.id}`}
          project={repo.project}
          expanded={expandedRepos.has(repo.id)}
          isSelected={idx === selectedIndex}
          worktreeCount={repo.worktrees.length}
        />,
      );
      continue;
    }

    if (item.type === "detail") {
      elements.push(
        <DetailRow
          key={`detail-${repo.id}-${item.worktreeIndex}-${item.detailKind}-${item.label}`}
          kind={item.detailKind}
          label={item.label}
          isSelected={idx === selectedIndex}
          meta={item.meta}
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
    const notifications = notifCounts.get(wtKey) ?? 0;
    const pending = pendingActions.get(wtKey);

    const wtPr = prData.get(wtKey);
    const wtPanes = panes.get(sessionName);
    const hasExpandableData =
      !!wtPr || (wtPanes && wtPanes.length > 0) || notifications > 0;

    elements.push(
      <WorktreeItem
        key={`wt-${repo.id}-${wt.branch}`}
        branch={wt.branch}
        hasSession={!!session}
        isAttached={session?.attached ?? false}
        sync={formatSync(wt.sync)}
        changedFiles={wt.changedFiles}
        notifications={notifications}
        isSelected={idx === selectedIndex}
        pendingStatus={pending?.type}
        isExpanded={expandedWorktreeKey === wtKey}
        hasExpandableData={!!hasExpandableData}
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
              notifications={0}
              isSelected={false}
              pendingStatus="opening"
            />,
          );
        }
      }
    }
  }

  // Phantoms for expanded repos with no worktrees
  for (const repo of repos) {
    if (!expandedRepos.has(repo.id)) continue;
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
          notifications={0}
          isSelected={false}
          pendingStatus="opening"
        />,
      );
    }
  }

  return <Box flexDirection="column">{elements}</Box>;
}

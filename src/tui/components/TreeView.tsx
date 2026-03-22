import { basename } from "node:path";
import { Box } from "ink";
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
  const sessionMap = new Map(sessions.map((s) => [s.name, s]));
  const notifCounts = new Map<string, number>();
  for (const item of queueItems) {
    const key = `${item.project}/${item.branch}`;
    notifCounts.set(key, (notifCounts.get(key) ?? 0) + 1);
  }

  // Build a set of existing worktree keys per repo for phantom detection
  const existingKeys = new Set<string>();
  for (const repo of repos) {
    for (const wt of repo.worktrees) {
      existingKeys.add(pendingKey(repo.project, wt.branch));
    }
  }

  // Collect phantom (opening) items per repo project
  const phantomsByProject = new Map<string, PendingAction[]>();
  for (const [key, action] of pendingActions) {
    if (action.type === "opening" && !existingKeys.has(key)) {
      const existing = phantomsByProject.get(action.project) ?? [];
      existing.push(action);
      phantomsByProject.set(action.project, existing);
    }
  }

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

      // If expanded and this is the last item for this repo (or next item is a different repo),
      // append phantom items after the last worktree
      // We handle phantoms after the worktree items below
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
    const notifKey = `${repo.project}/${wt.branch}`;
    const notifications = notifCounts.get(notifKey) ?? 0;

    const wtKey = pendingKey(repo.project, wt.branch);
    const pending = pendingActions.get(wtKey);

    // Determine if this worktree has expandable data
    const wtPr = prData.get(wtKey);
    const wtPanes = panes.get(sessionName);
    const wtNotifCount = notifCounts.get(notifKey) ?? 0;
    const hasExpandableData =
      !!wtPr || (wtPanes && wtPanes.length > 0) || wtNotifCount > 0;
    const isExpanded = expandedWorktreeKey === wtKey;

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
        isExpanded={isExpanded}
        hasExpandableData={!!hasExpandableData}
      />,
    );

    // Check if this is the last worktree for this repo — append phantoms
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

  // Handle phantoms for repos that are collapsed (no worktree items rendered)
  // by checking repos with expanded state and phantoms
  for (const repo of repos) {
    if (!expandedRepos.has(repo.id)) continue;
    if (repo.worktrees.length > 0) continue; // already handled above
    const phantoms = phantomsByProject.get(repo.project);
    if (!phantoms) continue;
    // Find the repo element index and insert phantoms after it
    // Since we're building elements array, just append them
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

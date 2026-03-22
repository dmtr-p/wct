import { basename } from "node:path";
import { Box } from "ink";
import type { QueueItem } from "../../services/queue-storage";
import { formatSessionName } from "../../services/tmux";
import { formatSync } from "../../services/worktree-status";
import type { RepoInfo } from "../hooks/useRegistry";
import type { TreeItem } from "../types";
import { RepoNode } from "./RepoNode";
import { WorktreeItem } from "./WorktreeItem";

interface Props {
  repos: RepoInfo[];
  sessions: Array<{ name: string; attached: boolean }>;
  queueItems: QueueItem[];
  expandedRepos: Set<string>;
  selectedIndex: number;
  items: TreeItem[];
}

export function TreeView({
  repos,
  sessions,
  queueItems,
  expandedRepos,
  selectedIndex,
  items,
}: Props) {
  const sessionMap = new Map(sessions.map((s) => [s.name, s]));
  const notifCounts = new Map<string, number>();
  for (const item of queueItems) {
    const key = `${item.project}/${item.branch}`;
    notifCounts.set(key, (notifCounts.get(key) ?? 0) + 1);
  }

  return (
    <Box flexDirection="column">
      {items.map((item, idx) => {
        const repo = repos[item.repoIndex];
        if (!repo) {
          return null;
        }

        if (item.type === "repo") {
          return (
            <RepoNode
              key={`repo-${repo.id}`}
              project={repo.project}
              expanded={expandedRepos.has(repo.id)}
              isSelected={idx === selectedIndex}
              worktreeCount={repo.worktrees.length}
            />
          );
        }

        const worktreeIndex = item.worktreeIndex;
        if (worktreeIndex === undefined) {
          return null;
        }

        const wt = repo.worktrees[worktreeIndex];
        if (!wt) {
          return null;
        }

        const sessionName = formatSessionName(basename(wt.path));
        const session = sessionMap.get(sessionName);
        const notifKey = `${repo.project}/${wt.branch}`;
        const notifications = notifCounts.get(notifKey) ?? 0;

        return (
          <WorktreeItem
            key={`wt-${repo.id}-${wt.branch}`}
            branch={wt.branch}
            hasSession={!!session}
            isAttached={session?.attached ?? false}
            sync={formatSync(wt.sync)}
            changedFiles={wt.changedFiles}
            notifications={notifications}
            isSelected={idx === selectedIndex}
          />
        );
      })}
    </Box>
  );
}

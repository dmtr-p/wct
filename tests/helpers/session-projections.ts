import { basename } from "node:path";
import {
  formatSessionName,
  workspaceSessionName,
  type WorkspaceSessionTarget,
  workspaceSessionTarget,
} from "../../src/services/session-identity";
import type { RepoInfo } from "../../src/tui/hooks/useRegistry";

/** Existing presentation fixtures model verified legacy sessions by basename. */
export function projectFixtureSessions<A>(
  repos: readonly RepoInfo[],
  entries: ReadonlyMap<string, A>,
): Map<string, A> {
  const projected = new Map(entries);
  for (const repo of repos)
    for (const worktree of repo.worktrees) {
      const value = entries.get(formatSessionName(basename(worktree.path)));
      if (value !== undefined)
        projected.set(
          workspaceSessionName(workspaceSessionTarget(repo.repoPath, worktree)),
          value,
        );
    }
  return projected;
}

export function legacySession(target: WorkspaceSessionTarget) {
  return {
    name: formatSessionName(basename(target.worktreePath)),
    id: "$1",
    server: "test-server",
    ownership: {
      mainRepoPath: target.mainRepoPath,
      branch: target.branch,
      worktreePath: target.worktreePath,
    },
    attached: false,
    windows: 1,
  };
}

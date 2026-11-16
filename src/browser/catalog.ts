import type { RepoInfo } from "../services/local-observation-service";
import {
  selectWorkspaceSession,
  workspaceSessionTarget,
} from "../services/session-identity";
import type { TmuxSession } from "../services/tmux";
import type { LocalCatalogProjects } from "./protocol";

/** A read-only projection; session selection and ownership remain service policy. */
export function projectLocalCatalog(
  repos: readonly RepoInfo[],
  sessions: readonly TmuxSession[],
): LocalCatalogProjects {
  return repos.map((repo) => ({
    mainRepoPath: repo.repoPath,
    displayName: repo.project,
    ...(repo.error ? { error: repo.error } : {}),
    workspaces: repo.worktrees.map((tree) => {
      const target = workspaceSessionTarget(repo.repoPath, tree);
      const selection = selectWorkspaceSession(sessions, target);
      const session =
        selection.type === "owned" ? selection.session : undefined;
      return {
        worktreePath: tree.path,
        branch: target.branch,
        target:
          session?.id && session.server
            ? { ...target, sessionId: session.id, server: session.server }
            : null,
      };
    }),
  }));
}

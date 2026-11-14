import {
  ownsWorkspaceSession,
  type WorkspaceSessionTarget,
} from "../services/session-identity";
import type { TmuxClient, TmuxSession } from "../services/tmux";
import type { LocalTarget, WorkspaceTarget } from "./protocol";

/** Project verified ownership without treating native sessions' WCT-shaped labels as authority. */
export async function inspectLocalTarget(
  client: TmuxClient,
  sources: {
    sessions: () => Promise<TmuxSession[] | null>;
    initial: WorkspaceTarget;
    canonical: (
      target: WorkspaceSessionTarget,
    ) => Promise<WorkspaceSessionTarget>;
    worktrees: (
      mainRepoPath: string,
    ) => Promise<{ path: string; branch: string }[]>;
    root: (path: string) => Promise<string>;
  },
): Promise<LocalTarget> {
  const current = (await sources.sessions())?.find(
    (s) => s.id === client.sessionId && s.server === client.server,
  );
  if (!current?.id || !current.server) throw new Error("Session disappeared");
  const native = {
    server: current.server,
    sessionId: current.id,
    sessionName: current.name,
  };
  let target: WorkspaceSessionTarget;
  const owner = current.ownership;
  // Known selection supplies redundant paths for identity-only ownership records.
  if (
    current.id === sources.initial.sessionId &&
    current.server === sources.initial.server &&
    ownsWorkspaceSession(current, sources.initial)
  ) {
    const { mainRepoPath, worktreePath, branch } = sources.initial;
    target = { mainRepoPath, worktreePath, branch };
  } else if (
    owner?.mainRepoPath &&
    owner.worktreePath &&
    owner.branch !== undefined
  ) {
    target = await sources.canonical({
      mainRepoPath: owner.mainRepoPath,
      worktreePath: owner.worktreePath,
      branch: owner.branch,
    });
    if (!ownsWorkspaceSession(current, target)) return native;
  } else return native;
  const checkout = (await sources.worktrees(target.mainRepoPath)).find(
    (w) => w.path === target.worktreePath,
  );
  if (!checkout) throw new Error("Workspace disappeared");
  target = {
    ...target,
    branch: checkout.branch === "(detached)" ? "" : checkout.branch,
  };
  if (!ownsWorkspaceSession(current, target))
    throw new Error("Workspace ownership changed");
  // A stale Git registration does not prove the checkout still exists.
  if ((await sources.root(target.worktreePath)) !== target.worktreePath)
    throw new Error("Workspace disappeared");
  return { ...target, server: current.server, sessionId: current.id };
}

import {
  findWorkspaceSession,
  workspaceSessionName,
  workspaceSessionTarget,
} from "../services/session-identity";
import type { TmuxPaneInfo } from "../services/tmux";
import type { RepoInfo } from "./hooks/useRegistry";
import type { TmuxSessionInfo } from "./hooks/useTmux";

export function workspacePaneMap(
  repos: readonly RepoInfo[],
  sessions: readonly TmuxSessionInfo[],
  panes: ReadonlyMap<string, TmuxPaneInfo[]>,
): Map<string, TmuxPaneInfo[]> {
  const result = new Map<string, TmuxPaneInfo[]>();
  for (const repo of repos)
    for (const worktree of repo.worktrees) {
      const target = workspaceSessionTarget(repo.repoPath, worktree);
      const session = findWorkspaceSession(sessions, target);
      const ownedPanes = session ? panes.get(session.name) : undefined;
      if (ownedPanes) result.set(workspaceSessionName(target), ownedPanes);
    }
  return result;
}

import type { WorkspaceUpResult } from "../services/workspace-service";
import type { TmuxClientDiscovery } from "./hooks/useTmux";

interface ResolveSessionsSwitchTargetOptions {
  client: TmuxClientDiscovery;
  targetSessions: readonly string[];
  sessions: Array<{ name: string }>;
}

type SessionHandoff =
  | { type: "not-needed" }
  | { type: "blocked" }
  | { type: "detach" }
  | { type: "switch"; sessionName: string };

export function resolveSessionsHandoff({
  client,
  targetSessions,
  sessions,
}: ResolveSessionsSwitchTargetOptions): SessionHandoff {
  const targets = new Set(targetSessions);
  const targetExists = sessions.some((session) => targets.has(session.name));
  if (!targetExists) {
    return { type: "not-needed" };
  }

  if (client.type === "multiple" || client.type === "error") {
    return { type: "blocked" };
  }

  if (client.type !== "single" || !targets.has(client.client.session)) {
    return { type: "not-needed" };
  }

  const fallbackSession = sessions.find(
    (session) => !targets.has(session.name),
  )?.name;

  if (!fallbackSession) {
    return { type: "detach" };
  }

  return {
    type: "switch",
    sessionName: fallbackSession,
  };
}

export function resolveStartActionMessage(
  result: WorkspaceUpResult,
): string | null {
  const tmuxError =
    result.attempts.tmux.attempted && !result.attempts.tmux.ok
      ? result.attempts.tmux.error.message
      : null;
  return tmuxError;
}

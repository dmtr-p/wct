// src/tui/session-utils.ts

import type { StartWorktreeSessionResult } from "../commands/worktree-session";
import { commandError } from "../errors";
import type { WorkspaceUpResult } from "../services/workspace-service";
import type { TmuxClientDiscovery } from "./hooks/useTmux";

interface ResolveSessionSwitchTargetOptions {
  client: TmuxClientDiscovery;
  targetSession: string;
  sessions: Array<{ name: string }>;
}

type SessionHandoff =
  | { type: "not-needed" }
  | { type: "blocked" }
  | { type: "detach" }
  | { type: "switch"; sessionName: string };

export function resolveSessionHandoff({
  client,
  targetSession,
  sessions,
}: ResolveSessionSwitchTargetOptions): SessionHandoff {
  const targetExists = sessions.some(
    (session) => session.name === targetSession,
  );
  if (!targetExists) {
    return { type: "not-needed" };
  }

  if (client.type === "multiple" || client.type === "error") {
    return { type: "blocked" };
  }

  if (client.type !== "single" || client.client.session !== targetSession) {
    return { type: "not-needed" };
  }

  const fallbackSession = sessions.find(
    (session) => session.name !== targetSession,
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
  result: StartWorktreeSessionResult,
): string | null {
  const tmuxError =
    result.tmux.attempted && !result.tmux.ok ? result.tmux.error.message : null;
  const ideError =
    result.ide.attempted && !result.ide.ok ? result.ide.error.message : null;

  if (tmuxError && ideError) {
    return `${tmuxError} (IDE also failed: ${ideError})`;
  }

  return tmuxError ?? ideError;
}

export function workspaceUpToStartResult(
  result: WorkspaceUpResult,
): StartWorktreeSessionResult {
  const tmux =
    result.attempts.tmux.attempted && !result.attempts.tmux.ok
      ? {
          attempted: true as const,
          ok: false as const,
          error: commandError(
            "unexpected_error",
            result.attempts.tmux.error.message,
            result.attempts.tmux.error.code,
          ),
        }
      : result.attempts.tmux.attempted
        ? result.attempts.tmux
        : { attempted: false as const };

  const ide =
    result.attempts.ide.attempted && !result.attempts.ide.ok
      ? {
          attempted: true as const,
          ok: false as const,
          error: commandError(
            "unexpected_error",
            result.attempts.ide.error.message,
            result.attempts.ide.error.code,
          ),
        }
      : result.attempts.ide.attempted
        ? {
            attempted: true as const,
            ok: true as const,
            value: undefined,
          }
        : { attempted: false as const };

  return {
    worktreePath: result.worktreePath,
    mainRepoPath: result.mainRepoPath,
    branch: result.branch,
    sessionName: result.sessionName,
    projectName: result.projectName,
    ...(result.profileName ? { profileName: result.profileName } : {}),
    env: result.env,
    tmux,
    ide,
  };
}

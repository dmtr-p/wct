// src/tui/session-utils.ts

import type { StartWorktreeSessionResult } from "../commands/worktree-session";
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

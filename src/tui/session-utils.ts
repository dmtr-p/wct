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
  if (result.tmux.attempted && !result.tmux.ok) {
    return result.tmux.error.message;
  }

  if (result.ide.attempted && !result.ide.ok) {
    return result.ide.error.message;
  }

  return null;
}

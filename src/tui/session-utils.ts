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
  result: WorkspaceUpResult,
): string | null {
  const tmuxError =
    result.attempts.tmux.attempted && !result.attempts.tmux.ok
      ? result.attempts.tmux.error.message
      : null;
  const ideError =
    result.attempts.ide.attempted && !result.attempts.ide.ok
      ? result.attempts.ide.error.message
      : null;

  if (tmuxError && ideError) {
    return `${tmuxError} (IDE also failed: ${ideError})`;
  }

  return tmuxError ?? ideError;
}

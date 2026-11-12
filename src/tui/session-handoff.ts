import type { WorkspaceSessionTarget } from "../services/session-identity";
import type { TmuxClient } from "../services/tmux";
import type { WorkspaceUpResult } from "../services/workspace-service";
import type { TmuxClientDiscovery, TmuxSwitchResult } from "./hooks/useTmux";

export interface SessionHandoffDeps {
  isPresentationActive?: () => boolean;
  /** Resolves after removal of this Workspace's progress row is flushed to stdout. */
  waitForLifecyclePresentationCleanup: (
    repoPath: string,
    branch: string,
  ) => Promise<void | boolean>;
  discoverClient: () => Promise<TmuxClientDiscovery>;
  switchSession: (
    name: string,
    client?: TmuxClient | null,
    target?: WorkspaceSessionTarget,
  ) => Promise<TmuxSwitchResult>;
  refreshSessions?: () => Promise<unknown>;
}

interface SessionHandoffOptions {
  repoPath: string;
  branch: string;
  sessionName: string;
  target?: WorkspaceSessionTarget;
  tmux: WorkspaceUpResult["attempts"]["tmux"];
  autoSwitch: boolean;
  wording: { action: "open" | "start"; completed: "Opened" | "Started" };
}

// Called after validation and release of lifecycle ownership. Switching can
// detach the TUI's terminal immediately, so wait for the rendered cleanup too.
export function createSessionHandoff(deps: SessionHandoffDeps) {
  return async ({
    repoPath,
    branch,
    sessionName,
    target,
    tmux,
    autoSwitch,
    wording,
  }: SessionHandoffOptions): Promise<string | undefined> => {
    if (!autoSwitch || !tmux.attempted || !tmux.ok) return undefined;

    if (
      (await deps.waitForLifecyclePresentationCleanup(repoPath, branch)) ===
      false
    )
      return undefined;
    const liveClient = await deps.discoverClient();
    if (deps.isPresentationActive?.() === false) return undefined;
    if (liveClient.type === "single") {
      const switched = target
        ? await deps.switchSession(sessionName, liveClient.client, target)
        : await deps.switchSession(sessionName, liveClient.client);
      if (switched === "inactive") return undefined;
      const failure =
        switched === false
          ? `${wording.completed} session '${sessionName}', but failed to switch client`
          : undefined;
      if (deps.isPresentationActive?.() === false) return failure;
      await deps.refreshSessions?.();
      return failure;
    }
    if (liveClient.type === "none") {
      return "No tmux client found — start tmux in the other pane";
    }
    if (liveClient.type === "error") {
      return `${wording.completed} session '${sessionName}' but failed to query tmux clients to switch`;
    }
    return `Cannot switch tmux client after ${wording.action} because multiple tmux clients are attached`;
  };
}

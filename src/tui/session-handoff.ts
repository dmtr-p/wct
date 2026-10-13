import type { TmuxClient } from "../services/tmux";
import type { WorkspaceUpResult } from "../services/workspace-service";
import type { TmuxClientDiscovery } from "./hooks/useTmux";

export interface SessionHandoffDeps {
  /** Resolves after removal of this Workspace's progress row is flushed to stdout. */
  waitForLifecyclePresentationCleanup: (
    repoPath: string,
    branch: string,
  ) => Promise<void>;
  discoverClient: () => Promise<TmuxClientDiscovery>;
  switchSession: (name: string, client?: TmuxClient | null) => Promise<boolean>;
  refreshSessions?: () => Promise<unknown>;
}

interface SessionHandoffOptions {
  repoPath: string;
  branch: string;
  sessionName: string;
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
    tmux,
    autoSwitch,
    wording,
  }: SessionHandoffOptions): Promise<string | undefined> => {
    if (!autoSwitch || !tmux.attempted || !tmux.ok) return undefined;

    await deps.waitForLifecyclePresentationCleanup(repoPath, branch);
    const liveClient = await deps.discoverClient();
    if (liveClient.type === "single") {
      const switched = await deps.switchSession(sessionName, liveClient.client);
      await deps.refreshSessions?.();
      return switched
        ? undefined
        : `${wording.completed} session '${sessionName}', but failed to switch client`;
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

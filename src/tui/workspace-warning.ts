import type { WorkspaceWarning } from "../services/workspace-service";

export function formatWorkspaceWarning(warning: WorkspaceWarning): string {
  switch (warning._tag) {
    case "DownFailed":
      return `Optional down script failed: ${warning.name}: ${warning.error.message}`;
    case "SetupFailed":
      return `${warning.optional ? "Optional setup failed" : "Setup failed"}: ${warning.name}: ${warning.error.message}`;
    case "TmuxStartFailed":
      return `Failed to create tmux session: ${warning.error.message}`;
  }
}

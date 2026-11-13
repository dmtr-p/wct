import { Console, Effect } from "effect";
import type { WorkspaceReporter } from "../services/workspace-service";

export function withWorkspaceWaitReporter(
  reporter?: WorkspaceReporter,
): WorkspaceReporter {
  return {
    event: (event) =>
      event._tag === "PhaseStarted" && event.phase._tag === "Waiting"
        ? Console.error(
            `Waiting for Workspace '${event.phase.branch}' in '${event.phase.mainRepoPath}'; Ctrl-C cancels this wait`,
          )
        : (reporter?.event(event) ?? Effect.void),
  };
}

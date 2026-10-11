import { Effect, Stdio } from "effect";
import type { WorkspaceReporter } from "../services/workspace-service";
import * as logger from "../utils/logger";

export function createDownHumanReporter(stdio: Stdio.Stdio): WorkspaceReporter {
  return {
    event: (event) => {
      let output: Effect.Effect<void, never, Stdio.Stdio> = Effect.void;
      if (event._tag === "ShutdownDelegated") {
        output = logger.info(
          `Shutdown continues independently; result: ${event.resultPath}`,
        );
      } else if (event._tag === "DownCommandStarted") {
        output = logger.step(event.current, event.total, `Down: ${event.name}`);
      } else if (event._tag === "DownCommandCompleted") {
        const { result } = event;
        if (result._tag === "OptionalFailed") {
          output = logger.warn(
            `${result.name} failed (optional): ${result.error ?? "Unknown error"}`,
          );
        } else if (result._tag === "Failed") {
          output = logger.error(
            `${result.name} failed: ${result.error ?? "Unknown error"}`,
          );
        }
      }
      return Effect.provideService(output, Stdio.Stdio, stdio);
    },
  };
}

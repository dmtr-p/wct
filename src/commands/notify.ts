import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import {
  execProcess,
  getProcessErrorMessage,
  readStdinText,
} from "../services/process";
import { QueueStorage } from "../services/queue-storage";
import { formatSessionName, isMissingPaneError } from "../services/tmux";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "notify",
  description: "Queue a notification from Claude Code hooks",
};

export function isPaneCurrentlyVisible(output: string): boolean {
  const [paneActive, windowVisible, attachedCountRaw] = output.split(":");
  const attachedCount = Number.parseInt(attachedCountRaw ?? "0", 10);
  return (
    paneActive === "1" &&
    windowVisible === "1" &&
    (Number.isNaN(attachedCount) ? 0 : attachedCount) > 0
  );
}

export function notifyCommand(): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const tmuxPane = process.env.TMUX_PANE;
    const branch = process.env.WCT_BRANCH;
    const project = process.env.WCT_PROJECT;

    if (!tmuxPane || !branch || !project) {
      return;
    }

    const stdinResult = yield* Effect.catch(
      Effect.mapError(readStdinText(), (error) =>
        commandError(
          "notify_error",
          "Failed to read notification input",
          error,
        ),
      ).pipe(Effect.map((stdin) => ({ _tag: "Ok" as const, stdin }))),
      (error) =>
        Effect.succeed({
          _tag: "Error" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
    );
    if (stdinResult._tag === "Error") {
      const message = stdinResult.message;
      yield* logger.warn(
        `Failed to process notification for branch='${branch}' project='${project}' pane='${tmuxPane}': ${message}`,
      );
      return;
    }
    const stdin = stdinResult.stdin;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(stdin) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield* logger.warn(
        `Failed to process notification for branch='${branch}' project='${project}' pane='${tmuxPane}': ${message}`,
      );
      return;
    }

    let session = formatSessionName(`${project}-${branch}`);
    const inspectOutcome = yield* Effect.catch(
      Effect.mapError(
        execProcess("tmux", [
          "display-message",
          "-p",
          "-t",
          tmuxPane,
          "#{pane_active}:#{window_visible}:#{session_attached}:#{session_name}",
        ]),
        (error) =>
          commandError("notify_error", "Failed to inspect tmux pane", error),
      ).pipe(Effect.map((result) => ({ _tag: "Ok" as const, result }))),
      (error) =>
        isMissingPaneError(error)
          ? Effect.succeed({ _tag: "MissingPane" as const } as
              | { _tag: "MissingPane" }
              | { _tag: "InspectionFailed" })
          : logger
              .warn(
                `Failed to inspect tmux pane '${tmuxPane}' for queued notification: ${getProcessErrorMessage(error)}`,
              )
              .pipe(
                Effect.as({ _tag: "InspectionFailed" as const } as
                  | { _tag: "MissingPane" }
                  | { _tag: "InspectionFailed" }),
              ),
    );

    if (inspectOutcome._tag === "MissingPane") {
      return;
    }

    if (inspectOutcome._tag === "Ok") {
      const output = inspectOutcome.result.stdout.trim();
      const lastColon = output.lastIndexOf(":");
      const visibilityPart = output.slice(0, lastColon);
      const sessionName = output.slice(lastColon + 1);
      if (isPaneCurrentlyVisible(visibilityPart)) {
        return;
      }
      if (sessionName) {
        session = sessionName;
      }
    }

    const queued = yield* Effect.catch(
      QueueStorage.use((service) =>
        service.addItem({
          branch,
          project,
          type: String(data.notification_type ?? data.type ?? "unknown"),
          message: String(data.message ?? data.title ?? ""),
          session,
          pane: tmuxPane,
        }),
      ).pipe(Effect.as(true)),
      (error) =>
        logger
          .warn(
            `Failed to queue notification for branch='${branch}' project='${project}' session='${session}' pane='${tmuxPane}': ${error instanceof Error ? error.message : String(error)}`,
          )
          .pipe(Effect.as(false)),
    );
    if (!queued) {
      return;
    }

    yield* Effect.catch(
      Effect.mapError(execProcess("tmux", ["refresh-client", "-S"]), (error) =>
        commandError("notify_error", "Failed to refresh tmux client", error),
      ),
      (error) =>
        logger.warn(
          `Failed to refresh tmux status after queueing notification session='${session}' pane='${tmuxPane}': ${getProcessErrorMessage(error)}`,
        ),
    );
  });
}

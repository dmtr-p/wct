import { Effect, Stdio } from "effect";
import { JsonFlag } from "../cli/json-flag";
import type { WctServices } from "../effect/services";
import type { WctError } from "../errors";
import {
  type WorkspaceOpenOptions,
  type WorkspaceOpenResult,
  type WorkspaceReporter,
  type WorkspaceReporterEvent,
  WorkspaceService,
} from "../services/workspace-service";
import { jsonSuccess } from "../utils/json-output";
import * as logger from "../utils/logger";
import { maybeAttachSession } from "./session";

export { openCommandDef as commandDef } from "../cli/command-metadata";

export interface OpenCommandOptions extends WorkspaceOpenOptions {
  noAttach?: boolean;
}

function logWorkspaceOpenResult(result: WorkspaceOpenResult) {
  return Effect.gen(function* () {
    if (result.profileName) {
      yield* logger.info(`Using profile '${result.profileName}'`);
    }

    if (result.created) {
      yield* logger.success(`Created worktree at ${result.worktreePath}`);
    } else {
      yield* logger.info("Worktree already exists");
    }

    if (result.attempts.copy.attempted && result.attempts.copy.ok) {
      const copied = result.attempts.copy.value.filter((r) => r.success).length;
      yield* logger.success(
        `Copied ${copied}/${result.attempts.copy.value.length} files`,
      );
    }

    if (result.attempts.setup.attempted && result.attempts.setup.ok) {
      const failedRequired = result.attempts.setup.value.filter(
        (r) => r._tag === "Failed",
      );
      const failedOptional = result.attempts.setup.value.filter(
        (r) => r._tag === "OptionalFailed",
      );
      if (failedRequired.length === 0 && failedOptional.length === 0) {
        yield* logger.success("Setup complete");
      } else if (failedRequired.length === 0) {
        yield* logger.warn(
          `Setup completed with ${failedOptional.length} optional failure${failedOptional.length === 1 ? "" : "s"}`,
        );
      } else {
        yield* logger.warn(
          `Setup completed with ${failedRequired.length} failure${failedRequired.length === 1 ? "" : "s"} and ${failedOptional.length} optional failure${failedOptional.length === 1 ? "" : "s"}`,
        );
      }
    } else if (result.attempts.setup.attempted && !result.attempts.setup.ok) {
      yield* logger.warn(
        `Setup failed: ${result.attempts.setup.error.message}`,
      );
    }

    if (result.attempts.tmux.attempted) {
      if (result.attempts.tmux.ok) {
        yield* result.attempts.tmux.value._tag === "AlreadyExists"
          ? logger.info(`Tmux session '${result.sessionName}' already exists`)
          : logger.success(`Created tmux session '${result.sessionName}'`);
      } else {
        yield* logger.warn(
          `Failed to create tmux session: ${result.attempts.tmux.error.message}`,
        );
      }
    }

    yield* logger.success(`Worktree '${result.branch}' is ready`);
  });
}

function createOpenHumanReporter(
  options: WorkspaceOpenOptions,
  stdio: Stdio.Stdio,
): WorkspaceReporter {
  let resolvedBranch = options.branch;
  let resolvedBase = options.base;

  const onEvent = (event: WorkspaceReporterEvent) => {
    if (event._tag === "TargetResolved") {
      resolvedBranch = event.branch ?? resolvedBranch;
      resolvedBase = event.base ?? resolvedBase;
      return Effect.void;
    }

    if (event._tag === "CopyEntrySkipped") {
      return event.reason === "directory_not_found_or_empty"
        ? logger.warn(`Directory not found or empty: ${event.entry}`)
        : logger.warn(`No files matched pattern: ${event.entry}`);
    }

    if (event._tag === "CopyEntryFailed") {
      return event.reason === "source_not_found"
        ? logger.warn(`File not found: ${event.file}`)
        : logger.warn(`Failed to copy ${event.file}: ${event.error}`);
    }

    if (event._tag === "SetupCommandStarted") {
      return logger.step(event.current, event.total, event.name);
    }

    if (event._tag === "SetupCommandCompleted") {
      if (event.result._tag === "OptionalFailed") {
        return logger.warn(
          `${event.result.name} failed (optional): ${event.result.error}`,
        );
      }
      if (event.result._tag === "Failed") {
        return logger.error(
          `${event.result.name} failed: ${event.result.error}`,
        );
      }
      return Effect.void;
    }

    if (event._tag !== "AttemptStarted") return Effect.void;

    switch (event.attempt) {
      case "worktree":
        return logger.info(
          `Creating worktree${resolvedBranch ? ` for '${resolvedBranch}'` : ""}${
            resolvedBase ? ` based on '${resolvedBase}'` : ""
          }`,
        );
      case "copy":
        return logger.info("Copying files...");
      case "setup":
        return logger.info("Running setup commands...");
      case "down":
        return Effect.void;
      case "tmux":
        return logger.info("Starting tmux session...");
    }
  };
  return {
    event: (event) => Effect.provideService(onEvent(event), Stdio.Stdio, stdio),
  };
}

export function openCommand(
  options: OpenCommandOptions,
): Effect.Effect<void, WctError, WctServices | "effect/cli/GlobalFlag/json"> {
  return Effect.gen(function* () {
    const { noAttach, ...workspaceOptions } = options;
    const json = yield* JsonFlag;
    const reporter = json
      ? undefined
      : createOpenHumanReporter(workspaceOptions, yield* Stdio.Stdio);
    const result = yield* WorkspaceService.use((service) =>
      service.open({
        ...workspaceOptions,
        ...(reporter ? { reporter } : {}),
      }),
    );

    if (json) {
      yield* jsonSuccess({ workspace: result });
      return;
    }

    yield* logWorkspaceOpenResult(result);

    if (result.attempts.tmux.attempted && result.attempts.tmux.ok) {
      yield* maybeAttachSession(result.sessionName, noAttach);
    }
  });
}

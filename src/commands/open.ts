import { Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";
import type { WctServices } from "../effect/services";
import type { WctError } from "../errors";
import {
  type WorkspaceOpenOptions,
  type WorkspaceOpenResult,
  type WorkspaceReporter,
  WorkspaceService,
} from "../services/workspace-service";
import { jsonSuccess } from "../utils/json-output";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";
import { maybeAttachSession } from "./session";

export const commandDef: CommandDef = {
  name: "open",
  description: "Create worktree, run setup, and start configured environment",
  args: "<branch>",
  options: [
    {
      name: "base",
      short: "b",
      type: "string",
      placeholder: "branch",
      description: "Base branch for new worktree (default: HEAD)",
    },
    {
      name: "existing",
      short: "e",
      type: "boolean",
      description: "Use existing branch",
    },
    {
      name: "ide",
      type: "boolean",
      description: "Force opening IDE",
    },
    {
      name: "no-ide",
      type: "boolean",
      description: "Skip opening IDE",
    },
    {
      name: "no-attach",
      type: "boolean",
      description: "Do not attach to tmux outside tmux",
    },
    {
      name: "pr",
      type: "string",
      placeholder: "number-or-url",
      description: "Open worktree from a GitHub PR",
    },
    {
      name: "prompt",
      short: "p",
      type: "string",
      placeholder: "text",
      description: "Set WCT_PROMPT env var in tmux session",
    },
    {
      name: "profile",
      short: "P",
      type: "string",
      placeholder: "name",
      description: "Use a named config profile",
      completionValues: "__wct_profiles",
    },
  ],
};

export interface OpenOptions {
  branch: string;
  existing: boolean;
  base?: string;
  cwd?: string;
  ide?: boolean;
  noIde?: boolean;
  prompt?: string;
  profile?: string;
}

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

    if (result.attempts.vscode.attempted) {
      if (result.attempts.vscode.ok) {
        yield* result.attempts.vscode.value.skipped
          ? logger.info("VS Code workspace already exists, skipping sync")
          : logger.success("VS Code workspace state synced");
      } else {
        yield* logger.warn(
          `VS Code workspace sync failed: ${result.attempts.vscode.error.message}`,
        );
      }
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

    if (result.attempts.ide.attempted) {
      if (result.attempts.ide.ok) {
        yield* logger.success("IDE opened");
      } else {
        yield* logger.warn(
          `Failed to open IDE: ${result.attempts.ide.error.message}`,
        );
      }
    }

    yield* logger.success(`Worktree '${result.branch}' is ready`);
  });
}

function createOpenHumanReporter(
  options: WorkspaceOpenOptions,
): WorkspaceReporter {
  let resolvedBranch = options.branch;
  let resolvedBase = options.base;

  return {
    event: (event) => {
      if (event._tag === "TargetResolved") {
        resolvedBranch = event.branch ?? resolvedBranch;
        resolvedBase = event.base ?? resolvedBase;
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
        case "vscode":
          return logger.info("Syncing VS Code workspace state...");
        case "copy":
          return logger.info("Copying files...");
        case "setup":
          return logger.info("Running setup commands...");
        case "tmux":
          return logger.info("Creating tmux session...");
        case "ide":
          return logger.info("Opening IDE...");
      }
    },
  };
}

export function openCommand(
  options: OpenCommandOptions,
): Effect.Effect<
  void,
  WctError,
  WctServices | "effect/unstable/cli/GlobalFlag/json"
> {
  return Effect.gen(function* () {
    const { noAttach, ...workspaceOptions } = options;
    const json = yield* JsonFlag;
    const result = yield* WorkspaceService.use((service) =>
      service.open({
        ...workspaceOptions,
        ...(json
          ? {}
          : { reporter: createOpenHumanReporter(workspaceOptions) }),
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

import { basename } from "node:path";
import { Console, Effect } from "effect";
import { loadConfig, resolveWorktreePath } from "../config/loader";
import type { WctServices } from "../effect/services";
import { commandError, toWctError, type WctError } from "../errors";
import { copyEntries } from "../services/copy";
import { IdeService } from "../services/ide-service";
import { SetupService } from "../services/setup-service";
import { formatSessionName, TmuxService } from "../services/tmux";
import { VSCodeWorkspaceService } from "../services/vscode-workspace";
import { WorktreeService } from "../services/worktree-service";
import type { WctEnv } from "../types/env";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "open",
  description: "Create worktree, run setup, start tmux session, open IDE",
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
      name: "no-ide",
      type: "boolean",
      description: "Skip opening IDE",
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
  ],
};

export interface OpenOptions {
  branch: string;
  existing: boolean;
  base?: string;
  noIde?: boolean;
  prompt?: string;
}

export function openCommand(
  options: OpenOptions,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const { branch, existing, base, noIde, prompt } = options;

    const repo = yield* WorktreeService.use((service) => service.isGitRepo());
    if (!repo) {
      return yield* Effect.fail(
        commandError("not_git_repo", "Not a git repository"),
      );
    }

    const mainDir = yield* WorktreeService.use((service) =>
      service.getMainRepoPath(),
    );
    if (!mainDir) {
      return yield* Effect.fail(
        commandError("worktree_error", "Could not determine repository root"),
      );
    }

    const { config, errors } = yield* Effect.tryPromise({
      try: () => loadConfig(mainDir),
      catch: (error) =>
        commandError("config_error", "Failed to load configuration", error),
    });
    if (!config) {
      return yield* Effect.fail(
        commandError("config_error", errors.join("\n")),
      );
    }

    if (existing && base) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Options --existing and --base cannot be used together",
        ),
      );
    }

    if (existing) {
      const exists = yield* WorktreeService.use((service) =>
        service.branchExists(branch),
      );
      if (!exists) {
        return yield* Effect.fail(
          commandError("branch_not_found", `Branch '${branch}' does not exist`),
        );
      }
    }

    if (base) {
      const baseExists = yield* WorktreeService.use((service) =>
        service.branchExists(base),
      );
      if (!baseExists) {
        return yield* Effect.fail(
          commandError(
            "base_branch_not_found",
            `Base branch '${base}' does not exist`,
          ),
        );
      }
    }

    const worktreePath = resolveWorktreePath(
      config.worktree_dir,
      branch,
      mainDir,
      config.project_name,
    );
    const sessionName = formatSessionName(basename(worktreePath));

    const env: WctEnv = {
      WCT_WORKTREE_DIR: worktreePath,
      WCT_MAIN_DIR: mainDir,
      WCT_BRANCH: branch,
      WCT_PROJECT: config.project_name,
      WCT_PROMPT: prompt,
    };

    yield* logger.info(
      `Creating worktree for '${branch}'${base ? ` based on '${base}'` : ""}`,
    );
    const worktreeResult = yield* WorktreeService.use((service) =>
      service.createWorktree(worktreePath, branch, existing, base),
    );

    if (worktreeResult._tag === "PathConflict") {
      return yield* Effect.fail(
        commandError(
          "worktree_error",
          `Path already exists for branch '${worktreeResult.existingBranch}', not '${branch}'`,
        ),
      );
    }

    if (worktreeResult._tag === "AlreadyExists") {
      yield* logger.info("Worktree already exists");
    } else {
      yield* logger.success(`Created worktree at ${worktreePath}`);
    }

    if (
      (config.ide?.name ?? "vscode") === "vscode" &&
      config.ide?.fork_workspace
    ) {
      yield* logger.info("Syncing VS Code workspace state...");
      const syncResult = yield* VSCodeWorkspaceService.use((service) =>
        service.syncWorkspaceState(mainDir, worktreePath),
      );
      if (syncResult.success && !syncResult.skipped) {
        yield* logger.success("VS Code workspace state synced");
      } else if (syncResult.skipped) {
        yield* logger.info("VS Code workspace already exists, skipping sync");
      } else {
        yield* logger.warn(
          `VS Code workspace sync failed: ${syncResult.error}`,
        );
      }
    }

    const copyConfig = config.copy;
    if (copyConfig && copyConfig.length > 0) {
      yield* logger.info("Copying files...");
      const copyResults = yield* Effect.mapError(
        copyEntries(copyConfig, mainDir, worktreePath),
        (error) =>
          commandError("worktree_error", "Failed to copy files", error),
      );
      const copied = copyResults.filter((r) => r.success).length;
      yield* logger.success(`Copied ${copied}/${copyResults.length} files`);
    }

    const setupConfig = config.setup;
    if (setupConfig && setupConfig.length > 0) {
      yield* logger.info("Running setup commands...");
      const setupResults = yield* SetupService.use((service) =>
        service.runSetupCommands(setupConfig, worktreePath, env),
      );
      const failedRequired = setupResults.filter((r) => r._tag === "Failed");
      const failedOptional = setupResults.filter(
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
    }

    if (config.tmux) {
      yield* logger.info("Creating tmux session...");
      yield* Effect.catch(
        TmuxService.use((service) =>
          service.createSession(sessionName, worktreePath, config.tmux, env),
        ).pipe(
          Effect.tap((tmuxResult) =>
            tmuxResult._tag === "AlreadyExists"
              ? logger.info(`Tmux session '${sessionName}' already exists`)
              : logger.success(`Created tmux session '${sessionName}'`),
          ),
        ),
        (error) =>
          logger.warn(
            `Failed to create tmux session: ${toWctError(error).message}`,
          ),
      );
    }

    const ideCommand = config.ide?.command;
    if (ideCommand && !noIde) {
      yield* logger.info("Opening IDE...");
      yield* Effect.catch(
        IdeService.use((service) => service.openIDE(ideCommand, env)).pipe(
          Effect.tap(() => logger.success("IDE opened")),
        ),
        (error) =>
          logger.warn(`Failed to open IDE: ${toWctError(error).message}`),
      );
    }

    yield* logger.success(`Worktree '${branch}' is ready`);
    if (config.tmux) {
      if (process.env.TMUX) {
        yield* Effect.catch(
          TmuxService.use((service) => service.switchSession(sessionName)).pipe(
            Effect.tap(() =>
              logger.success(`Switched to tmux session '${sessionName}'`),
            ),
          ),
          (error) =>
            logger.warn(
              `Failed to switch session: ${toWctError(error).message}`,
            ),
        );
      } else {
        yield* Console.log(
          `\nAttach to tmux session: ${logger.bold(`tmux attach -t ${sessionName}`)}`,
        );
      }
    }
  });
}

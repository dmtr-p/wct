import { basename } from "node:path";
import { Effect } from "effect";
import {
  loadConfig,
  resolveProfile,
  resolveWorktreePath,
} from "../config/loader";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { copyEntries } from "../services/copy";
import { GitHubService, parsePrArg } from "../services/github-service";
import { registerProject } from "../services/project-registration";
import { SetupService } from "../services/setup-service";
import { formatSessionName } from "../services/tmux";
import { VSCodeWorkspaceService } from "../services/vscode-workspace";
import { WorktreeService } from "../services/worktree-service";
import type { WctEnv } from "../types/env";
import * as logger from "../utils/logger";
import type { CommandDef } from "./command-def";
import { launchSessionAndIde, maybeAttachSession } from "./session";

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
  noIde?: boolean;
  prompt?: string;
  profile?: string;
}

export interface OpenRequest {
  branch?: string;
  existing?: boolean;
  base?: string;
  cwd?: string;
  noIde?: boolean;
  pr?: string;
  prompt?: string;
  profile?: string;
}

export interface OpenWorktreeResult {
  worktreePath: string;
  branch: string;
  sessionName: string;
  projectName: string;
  created: boolean;
  warnings: string[];
  tmuxSessionStarted: boolean;
}

export function resolveOpenOptions(
  input: OpenRequest,
): Effect.Effect<OpenOptions, WctError, WctServices> {
  return Effect.gen(function* () {
    const {
      branch,
      existing = false,
      base,
      cwd,
      noIde,
      pr,
      prompt,
      profile,
    } = input;

    if (pr && branch) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Cannot use --pr together with a branch argument",
        ),
      );
    }

    if (pr && base) {
      return yield* Effect.fail(
        commandError("invalid_options", "Cannot use --pr together with --base"),
      );
    }

    if (pr && existing) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Cannot use --pr together with --existing",
        ),
      );
    }

    if (pr) {
      const prNumber = parsePrArg(pr);
      if (prNumber === null) {
        return yield* Effect.fail(
          commandError(
            "pr_error",
            `Invalid --pr value: '${pr}'\n\nExpected a PR number or GitHub URL (e.g. 123 or https://github.com/user/repo/pull/123)`,
          ),
        );
      }

      const ghInstalled = yield* GitHubService.use((service) =>
        service.isGhInstalled(),
      );
      if (!ghInstalled) {
        return yield* Effect.fail(
          commandError(
            "gh_not_installed",
            "GitHub CLI (gh) is not installed.\n\nInstall it from https://cli.github.com/ and run 'gh auth login'",
          ),
        );
      }

      const resolvedPr = yield* GitHubService.use((service) =>
        service.resolvePr(prNumber, cwd),
      );
      const resolvedBranch = resolvedPr.branch;
      let remote = "origin";

      if (resolvedPr.headOwner && resolvedPr.headRepo) {
        const { headOwner, headRepo } = resolvedPr;
        const existingRemote = yield* GitHubService.use((service) =>
          service.findRemoteForRepo(headOwner, headRepo, cwd),
        );

        if (existingRemote) {
          remote = existingRemote;
        } else if (resolvedPr.isCrossRepository) {
          remote = headOwner;
          yield* GitHubService.use((service) =>
            service.addForkRemote(remote, headOwner, headRepo, cwd),
          );
        }
      }

      yield* GitHubService.use((service) =>
        service.fetchBranch(resolvedBranch, remote, cwd),
      );

      const localExists = yield* WorktreeService.use((service) =>
        service.branchExists(resolvedBranch, cwd),
      );

      return {
        branch: resolvedBranch,
        existing: localExists,
        base: localExists ? undefined : `${remote}/${resolvedBranch}`,
        cwd,
        noIde,
        prompt,
        profile,
      };
    }

    if (!branch) {
      return yield* Effect.fail(
        commandError("missing_branch_arg", "Missing branch name"),
      );
    }

    return {
      branch,
      existing,
      base,
      cwd,
      noIde,
      prompt,
      profile,
    };
  });
}

export function openWorktree(
  options: OpenOptions,
): Effect.Effect<OpenWorktreeResult, WctError, WctServices> {
  return Effect.gen(function* () {
    const { branch, existing, base, cwd, noIde, prompt, profile } = options;

    const repo = yield* WorktreeService.use((service) =>
      service.isGitRepo(cwd),
    );
    if (!repo) {
      return yield* Effect.fail(
        commandError("not_git_repo", "Not a git repository"),
      );
    }

    const mainDir = yield* WorktreeService.use((service) =>
      service.getMainRepoPath(cwd),
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

    const { config: resolved, profileName } = yield* Effect.try({
      try: () => resolveProfile(config, branch, profile),
      catch: (error) =>
        commandError(
          "config_error",
          error instanceof Error ? error.message : String(error),
        ),
    });
    if (profileName) {
      yield* logger.info(`Using profile '${profileName}'`);
    }

    // Auto-register repo in TUI registry
    yield* Effect.catch(
      registerProject({
        path: mainDir,
        name: resolved.project_name ?? basename(mainDir),
        tolerateConfigErrors: true,
      }),
      () => Effect.void,
    );

    if (existing && base) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Options --existing and --base cannot be used together",
        ),
      );
    }

    if (base) {
      const baseExists = yield* WorktreeService.use((service) =>
        service.branchExists(base, cwd),
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
    const warnings: string[] = [];

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
      service.createWorktree(worktreePath, branch, existing, base, cwd),
    );

    if (worktreeResult._tag === "PathConflict") {
      return yield* Effect.fail(
        commandError(
          "worktree_error",
          worktreeResult.existingBranch
            ? `Path already exists for branch '${worktreeResult.existingBranch}', not '${branch}'`
            : `Path '${worktreePath}' already exists and is not a registered worktree for '${branch}'`,
        ),
      );
    }

    if (worktreeResult._tag === "AlreadyExists") {
      yield* logger.info("Worktree already exists");
    } else {
      yield* logger.success(`Created worktree at ${worktreePath}`);
    }

    if (
      (resolved.ide?.name ?? "vscode") === "vscode" &&
      resolved.ide?.fork_workspace
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
        const warning = `VS Code workspace sync failed: ${syncResult.error}`;
        warnings.push(warning);
        yield* logger.warn(warning);
      }
    }

    const copyConfig = resolved.copy;
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

    const setupConfig = resolved.setup;
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

      for (const failure of failedRequired) {
        warnings.push(
          `Setup failed: ${failure.name}: ${failure.error ?? "Unknown error"}`,
        );
      }
      for (const failure of failedOptional) {
        warnings.push(
          `Optional setup failed: ${failure.name}: ${failure.error ?? "Unknown error"}`,
        );
      }
    }

    const launchResult = yield* launchSessionAndIde({
      sessionName,
      workingDir: worktreePath,
      tmuxConfig: resolved.tmux,
      env,
      ideCommand: resolved.ide?.command,
      noIde,
    });

    yield* logger.success(`Worktree '${branch}' is ready`);

    return {
      worktreePath,
      branch,
      sessionName,
      projectName: config.project_name,
      created: worktreeResult._tag !== "AlreadyExists",
      warnings,
      tmuxSessionStarted: launchResult.tmuxSessionStarted,
    };
  });
}

export interface OpenCommandOptions extends OpenOptions {
  noAttach?: boolean;
}

export function openCommand(
  options: OpenCommandOptions,
): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const result = yield* openWorktree(options);
    if (result.tmuxSessionStarted) {
      yield* maybeAttachSession(result.sessionName, options.noAttach);
    }
  });
}

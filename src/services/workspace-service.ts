import { resolve } from "node:path";
import type { BunServices } from "@effect/platform-bun";
import { Config, Context, Effect, FileSystem } from "effect";
import {
  loadConfig,
  loadWorkspaceConfig,
  resolveProfile,
  resolveWorktreePath,
} from "../config/loader";
import type { ResolvedConfig } from "../config/schema";
import { loadRuntimeConfig } from "../effect/config";
import {
  bindServiceContext,
  bunServiceKeys,
  type ServiceImplementation,
} from "../effect/service-context";
import { commandError, toWctError, type WctError } from "../errors";
import type { WctEnv } from "../types/env";
import { type CommandResult, runShellCommands } from "./command-runner";
import { copyEntries, copyFiles, type CopyResult } from "./copy";
import {
  GitHubService,
  type GitHubService as GitHubServiceApi,
  parsePrArg,
} from "./github-service";
import { getIncludeCopyState } from "./include-copy-state";
import { PrCacheService, type PrCacheServiceApi } from "./pr-cache-service";
import {
  canonicalSessionTarget,
  workspaceSessionName,
} from "./session-identity";
import {
  type SetupResult,
  SetupService,
  type SetupService as SetupServiceApi,
} from "./setup-service";
import { runDetachedShutdown, type ShutdownRequest } from "./shutdown-runner";
import {
  type CreateSessionResult,
  TmuxService,
  type TmuxService as TmuxServiceApi,
} from "./tmux";
import {
  CurrentWorkspaceLease,
  WorkspaceCoordinationService,
  type WorkspaceCoordinationServiceApi,
} from "./workspace-coordination";
import {
  assertWorkspaceConfirmation,
  assertWorkspaceTarget,
  inspectWorkspaceTarget,
  type WorkspaceConfirmation,
  type WorkspaceTargetEvidence,
} from "./workspace-target";
import { resolveWorktreeInclude } from "./worktree-include";
import {
  type CreateWorktreeResult,
  type RemoveWorktreeResult,
  WorktreeService,
  type WorktreeService as WorktreeServiceApi,
} from "./worktree-service";

export interface WorkspaceError {
  code: string;
  message: string;
}

export type WorkspaceOperation = "open" | "up" | "down" | "close";

export type WorkspaceAttempt<T> =
  | { attempted: false; reason: string }
  | { attempted: true; ok: true; value: T }
  | { attempted: true; ok: false; error: WorkspaceError };

export type WorkspaceDownWarning = {
  _tag: "DownFailed";
  operation: "down" | "close";
  name: string;
  optional: true;
  error: WorkspaceError;
};

export type WorkspaceWarning =
  | WorkspaceDownWarning
  | {
      _tag: "TmuxStartFailed";
      operation: "open" | "up";
      error: WorkspaceError;
    }
  | {
      _tag: "SetupFailed";
      operation: "open";
      name: string;
      optional: boolean;
      error: WorkspaceError;
    };

export type WorkspacePhase =
  | { _tag: "Preparing" }
  | { _tag: "Waiting"; mainRepoPath: string; branch: string }
  | { _tag: "CreatingWorktree" }
  | { _tag: "CopyingFiles" }
  | { _tag: "RunningSetup"; name: string }
  | { _tag: "RunningDown"; name: string }
  | { _tag: "StartingTmuxSession" }
  | { _tag: "StoppingTmuxSession" }
  | { _tag: "RemovingWorktree" };

export type WorkspaceReporterEvent =
  | {
      operation: "down" | "close";
      _tag: "ShutdownDelegated";
      resultPath: string;
    }
  | {
      operation: WorkspaceOperation;
      _tag: "PhaseStarted";
      phase: WorkspacePhase;
    }
  | {
      operation: WorkspaceOperation;
      _tag: "TargetResolved";
      worktreePath: string;
      branch?: string;
      base?: string;
    }
  | {
      operation: WorkspaceOperation;
      _tag: "AttemptStarted";
      attempt: "worktree" | "copy" | "setup" | "tmux" | "down";
    }
  | {
      operation: "open";
      _tag: "CopyEntrySkipped";
      entry: string;
      reason: "directory_not_found_or_empty" | "glob_no_matches";
    }
  | {
      operation: "open";
      _tag: "CopyEntryFailed";
      file: string;
      reason: "source_not_found" | "copy_failed";
      error: string;
    }
  | {
      operation: "open";
      _tag: "SetupCommandStarted";
      name: string;
      current: number;
      total: number;
    }
  | {
      operation: "open";
      _tag: "SetupCommandCompleted";
      result: SetupResult;
    }
  | {
      operation: "down" | "close";
      _tag: "DownCommandStarted";
      name: string;
      current: number;
      total: number;
    }
  | {
      operation: "down" | "close";
      _tag: "DownCommandCompleted";
      result: CommandResult;
    }
  | {
      operation: WorkspaceOperation;
      _tag: "SessionAbsent";
      sessionName: string;
    }
  | {
      operation: WorkspaceOperation;
      _tag: "SessionKilled";
      sessionName: string;
    };

export interface WorkspaceReporter {
  waitSignal?: AbortSignal;
  event: (event: WorkspaceReporterEvent) => Effect.Effect<void, WctError>;
}

export interface ResolveWorkspaceTargetOptions {
  path?: string;
  branch?: string;
  confirmedTarget?: WorkspaceTargetEvidence;
  confirmation?: WorkspaceConfirmation;
  expectedTarget?: import("./session-identity").WorkspaceSessionTarget;
  expectedSession?: import("./session-identity").WorkspaceSession | null;
}

export interface WorkspaceUpOptions extends ResolveWorkspaceTargetOptions {
  profile?: string;
  reporter?: WorkspaceReporter;
}

export interface WorkspaceDownOptions extends ResolveWorkspaceTargetOptions {
  profile?: string;
  reporter?: WorkspaceReporter;
}

export interface WorkspaceCloseOptions extends ResolveWorkspaceTargetOptions {
  profile?: string;
  cwd?: string;
  force?: boolean;
  /** Allows an independent runner to retry removal without a terminal prompt. */
  retryWithForce?: boolean;
  reporter?: WorkspaceReporter;
}

export interface WorkspaceOpenOptions {
  branch?: string;
  existing?: boolean;
  base?: string;
  cwd?: string;
  pr?: string;
  profile?: string;
  reporter?: WorkspaceReporter;
}

export interface WorkspaceOpenResult {
  operation: "open";
  worktreePath: string;
  mainRepoPath: string;
  branch: string;
  sessionName: string;
  projectName: string;
  profileName?: string;
  created: boolean;
  env: WctEnv;
  warnings: WorkspaceWarning[];
  attempts: {
    worktree: WorkspaceAttempt<CreateWorktreeResult>;
    copy: WorkspaceAttempt<CopyResult[]>;
    setup: WorkspaceAttempt<SetupResult[]>;
    tmux: WorkspaceAttempt<CreateSessionResult>;
  };
}

export interface WorkspaceUpResult {
  operation: "up";
  worktreePath: string;
  mainRepoPath: string;
  branch: string;
  sessionName: string;
  projectName: string;
  profileName?: string;
  env: WctEnv;
  warnings: WorkspaceWarning[];
  attempts: {
    tmux: WorkspaceAttempt<CreateSessionResult>;
  };
}

export interface WorkspaceDownResult {
  operation: "down";
  worktreePath: string;
  sessionName: string;
  existed: boolean;
  status: "killed" | "absent";
  attempts: {
    kill: WorkspaceAttempt<null>;
    down: WorkspaceAttempt<CommandResult[]>;
  };
  warnings: WorkspaceDownWarning[];
}

export interface WorkspaceCloseResult {
  removalTarget?: WorkspaceTargetEvidence;
  operation: "close";
  worktreePath: string;
  sessionName: string;
  existed: boolean;
  status: "removed" | "blocked_by_changes";
  attempts: {
    kill: WorkspaceAttempt<null>;
    down: WorkspaceAttempt<CommandResult[]>;
    remove: WorkspaceAttempt<RemoveWorktreeResult>;
  };
  warnings: WorkspaceDownWarning[];
}

export interface WorkspaceService {
  open: (
    options: WorkspaceOpenOptions,
  ) => Effect.Effect<WorkspaceOpenResult, WctError>;
  up: (
    options?: WorkspaceUpOptions,
  ) => Effect.Effect<WorkspaceUpResult, WctError>;
  down: (
    options?: WorkspaceDownOptions,
  ) => Effect.Effect<WorkspaceDownResult, WctError>;
  close: (
    options?: WorkspaceCloseOptions,
  ) => Effect.Effect<WorkspaceCloseResult, WctError>;
  retryCloseRemoval: (
    previous: WorkspaceCloseResult,
    options?: { cwd?: string; reporter?: WorkspaceReporter },
  ) => Effect.Effect<WorkspaceCloseResult, WctError>;
}

export const WorkspaceService = Context.Service<WorkspaceService>(
  "wct/WorkspaceService",
);

function toWorkspaceError(error: unknown): WorkspaceError {
  const wctError = toWctError(error);
  return {
    code: wctError.code,
    message: wctError.message,
  };
}

function skippedAttempt<T>(reason: string): WorkspaceAttempt<T> {
  return { attempted: false, reason };
}

function emitReporter(
  reporter: WorkspaceReporter | undefined,
  event: WorkspaceReporterEvent,
) {
  if (!reporter) return Effect.void;
  return Effect.suspend(() => reporter.event(event)).pipe(Effect.ignoreCause);
}

function emitPhase(
  reporter: WorkspaceReporter | undefined,
  operation: WorkspaceOperation,
  phase: WorkspacePhase,
): Effect.Effect<void> {
  return emitReporter(reporter, { operation, _tag: "PhaseStarted", phase });
}

function captureAttempt<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<WorkspaceAttempt<A>, WctError, R> {
  return Effect.matchEffect(effect, {
    onFailure: (error) => {
      const failure = toWctError(error);
      return failure.code === "workspace_coordination_error"
        ? Effect.fail(failure)
        : Effect.succeed({
            attempted: true as const,
            ok: false as const,
            error: toWorkspaceError(error),
          });
    },
    onSuccess: (value) =>
      Effect.succeed({ attempted: true as const, ok: true as const, value }),
  });
}

function startWorkspaceSession(options: {
  operation: "open" | "up";
  reporter?: WorkspaceReporter;
  sessionName: string;
  workingDir: string;
  tmuxConfig: ResolvedConfig["tmux"];
  env: WctEnv;
}) {
  return Effect.gen(function* () {
    const { operation, reporter, sessionName, workingDir, tmuxConfig, env } =
      options;
    if (!tmuxConfig) {
      return {
        tmux: skippedAttempt<CreateSessionResult>("tmux_not_configured"),
        warnings: [] as WorkspaceWarning[],
      };
    }

    yield* emitPhase(reporter, operation, { _tag: "StartingTmuxSession" });
    yield* emitReporter(reporter, {
      operation,
      _tag: "AttemptStarted",
      attempt: "tmux",
    });
    const tmux = yield* captureAttempt(
      TmuxService.use((service) =>
        service.createSession(sessionName, workingDir, tmuxConfig, env),
      ),
    );
    const warnings: WorkspaceWarning[] = [];
    if (tmux.attempted && !tmux.ok) {
      warnings.push({ _tag: "TmuxStartFailed", operation, error: tmux.error });
    }
    return { tmux, warnings };
  });
}

function setupWarning(result: SetupResult): WorkspaceWarning | undefined {
  if (result._tag === "Succeeded") return undefined;
  return {
    _tag: "SetupFailed",
    operation: "open",
    name: result.name,
    optional: result._tag === "OptionalFailed",
    error: {
      code:
        result._tag === "OptionalFailed"
          ? "optional_setup_failed"
          : "setup_failed",
      message: result.error,
    },
  };
}

function copyWorkspaceFiles(options: {
  config: ResolvedConfig;
  copyConfig: ResolvedConfig["copy"];
  profileName?: string;
  projectDefinesCopy: boolean;
  created: boolean;
  mainRepoPath: string;
  worktreePath: string;
  reporter?: WorkspaceReporter;
}): Effect.Effect<
  WorkspaceAttempt<CopyResult[]>,
  WctError,
  BunServices.BunServices
> {
  return Effect.gen(function* () {
    const {
      config,
      copyConfig,
      profileName,
      projectDefinesCopy,
      created,
      mainRepoPath,
      worktreePath,
      reporter,
    } = options;
    const profileDefinesCopy =
      profileName !== undefined &&
      config.profiles?.[profileName]?.copy !== undefined;
    const includeState = yield* getIncludeCopyState(worktreePath);
    const processInclude =
      !projectDefinesCopy &&
      !profileDefinesCopy &&
      (created || includeState.pending);
    if (processInclude) yield* includeState.begin;
    const includeFiles = processInclude
      ? yield* resolveWorktreeInclude(mainRepoPath)
      : undefined;
    const filesToCopy = includeFiles ?? copyConfig;
    const copyRoutine = includeFiles === undefined ? copyEntries : copyFiles;

    let copy = skippedAttempt<CopyResult[]>("copy_not_configured");
    if (filesToCopy && filesToCopy.length > 0) {
      yield* emitPhase(reporter, "open", { _tag: "CopyingFiles" });
      yield* emitReporter(reporter, {
        operation: "open",
        _tag: "AttemptStarted",
        attempt: "copy",
      });
      const results = yield* Effect.mapError(
        copyRoutine(filesToCopy, mainRepoPath, worktreePath, {
          entrySkipped: ({ entry, reason }) =>
            emitReporter(reporter, {
              operation: "open",
              _tag: "CopyEntrySkipped",
              entry,
              reason,
            }),
          entryFailed: ({ file, reason, error }) =>
            emitReporter(reporter, {
              operation: "open",
              _tag: "CopyEntryFailed",
              file,
              reason,
              error,
            }),
        }),
        (error) =>
          commandError(
            "worktree_error",
            `Failed to copy files: ${error instanceof Error ? error.message : String(error)}`,
            error,
          ),
      );
      const failed = results.find((result) => !result.success);
      if (failed) {
        return yield* commandError(
          "worktree_error",
          `Failed to copy files: ${failed.file}: ${failed.error ?? "Unknown error"}`,
        );
      }
      copy = { attempted: true, ok: true, value: results };
    }
    // Keep the marker on failure so reopening retries before setup runs.
    if (processInclude || includeState.pending) yield* includeState.complete;
    return copy;
  });
}

function runWorkspaceSetup(options: {
  setupConfig: ResolvedConfig["setup"];
  workingDir: string;
  env: WctEnv;
  reporter?: WorkspaceReporter;
}) {
  return Effect.gen(function* () {
    const { setupConfig, workingDir, env, reporter } = options;
    const warnings: WorkspaceWarning[] = [];
    if (!setupConfig || setupConfig.length === 0) {
      return {
        setup: skippedAttempt<SetupResult[]>("setup_not_configured"),
        warnings,
      };
    }

    yield* emitReporter(reporter, {
      operation: "open",
      _tag: "AttemptStarted",
      attempt: "setup",
    });
    const setup = yield* captureAttempt(
      SetupService.use((service) =>
        service.runSetupCommands(
          setupConfig,
          workingDir,
          env,
          reporter
            ? {
                commandStarted: (name, current, total) =>
                  Effect.all([
                    emitPhase(reporter, "open", {
                      _tag: "RunningSetup",
                      name,
                    }),
                    emitReporter(reporter, {
                      operation: "open",
                      _tag: "SetupCommandStarted",
                      name,
                      current,
                      total,
                    }),
                  ]).pipe(Effect.asVoid),
                commandCompleted: (result) =>
                  emitReporter(reporter, {
                    operation: "open",
                    _tag: "SetupCommandCompleted",
                    result,
                  }),
              }
            : undefined,
        ),
      ),
    );
    if (setup.attempted && setup.ok) {
      warnings.push(
        ...setup.value.flatMap((result) => {
          const warning = setupWarning(result);
          return warning ? [warning] : [];
        }),
      );
    } else if (setup.attempted && !setup.ok) {
      warnings.push({
        _tag: "SetupFailed",
        operation: "open",
        name: "setup",
        optional: false,
        error: setup.error,
      });
    }
    return { setup, warnings };
  });
}

function createWctEnv(
  worktreePath: string,
  workDir: string,
  mainRepoPath: string,
  branch: string,
  projectName: string,
): WctEnv {
  return {
    WCT_WORKTREE_DIR: worktreePath,
    WCT_WORK_DIR: resolve(worktreePath, workDir),
    WCT_MAIN_DIR: mainRepoPath,
    WCT_BRANCH: branch,
    WCT_PROJECT: projectName,
  };
}

function resolveWorkspaceProfile(
  config: ResolvedConfig,
  branch: string,
  profile?: string,
) {
  return Effect.try({
    try: () => resolveProfile(config, branch, profile),
    catch: (error) =>
      commandError(
        "config_error",
        error instanceof Error ? error.message : String(error),
      ),
  });
}

function resolveOpenIntent(
  options: WorkspaceOpenOptions,
  expectedBranch?: string,
): Effect.Effect<
  Required<Pick<WorkspaceOpenOptions, "branch" | "existing">> &
    Omit<WorkspaceOpenOptions, "branch" | "existing" | "pr" | "reporter"> & {
      prNumber?: number;
    },
  WctError,
  GitHubServiceApi | WorktreeServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const { branch, existing = false, base, cwd, pr, profile } = options;

    if (pr && branch) {
      return yield* commandError(
        "invalid_options",
        "Cannot use --pr together with a branch argument",
      );
    }

    if (pr && base) {
      return yield* commandError(
        "invalid_options",
        "Cannot use --pr together with --base",
      );
    }

    if (pr && existing) {
      return yield* commandError(
        "invalid_options",
        "Cannot use --pr together with --existing",
      );
    }

    if (pr) {
      const prNumber = parsePrArg(pr);
      if (prNumber === null) {
        return yield* commandError(
          "pr_error",
          `Invalid --pr value: '${pr}'\n\nExpected a PR number or GitHub URL (e.g. 123 or https://github.com/user/repo/pull/123)`,
        );
      }

      const ghInstalled = yield* GitHubService.use(
        (service) => service.isGhInstalled,
      );
      if (!ghInstalled) {
        return yield* commandError(
          "gh_not_installed",
          "GitHub CLI (gh) is not installed.\n\nInstall it from https://cli.github.com/ and run 'gh auth login'",
        );
      }

      const resolvedPr = yield* GitHubService.use((service) =>
        service.resolvePr(prNumber, cwd),
      );
      const resolvedBranch = resolvedPr.branch;
      if (expectedBranch !== undefined && resolvedBranch !== expectedBranch)
        return yield* commandError(
          "pr_error",
          "PR branch changed while waiting; retry Open",
        );
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
        prNumber,
        existing: localExists,
        base: localExists ? undefined : `${remote}/${resolvedBranch}`,
        cwd,
        profile,
      };
    }

    if (!branch) {
      return yield* commandError("missing_branch_arg", "Missing branch name");
    }

    return { branch, existing, base, cwd, profile };
  });
}

function openImpl(
  options: WorkspaceOpenOptions,
  expectedBranch?: string,
): Effect.Effect<
  WorkspaceOpenResult,
  WctError,
  | WorktreeServiceApi
  | TmuxServiceApi
  | SetupServiceApi
  | GitHubServiceApi
  | PrCacheServiceApi
  | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const reporter = options.reporter;
    yield* emitPhase(reporter, "open", { _tag: "Preparing" });
    const resolvedOptions = yield* resolveOpenIntent(options, expectedBranch);
    const { branch, existing, cwd, profile } = resolvedOptions;
    const explicitBase = resolvedOptions.base;

    const repo = yield* WorktreeService.use((service) =>
      service.isGitRepo(cwd),
    );
    if (!repo) {
      return yield* commandError("not_git_repo", "Not a git repository");
    }

    const mainRepoPath = yield* WorktreeService.use((service) =>
      service.getMainRepoPath(cwd),
    );
    if (!mainRepoPath) {
      return yield* commandError(
        "worktree_error",
        "Could not determine repository root",
      );
    }

    const { config, projectDefinesCopy } = yield* Effect.mapError(
      loadWorkspaceConfig(mainRepoPath),
      (error) => commandError("config_error", error.message, error),
    );
    const { config: resolved, profileName } = yield* resolveWorkspaceProfile(
      config,
      branch,
      profile,
    );
    if (existing && explicitBase) {
      return yield* commandError(
        "invalid_options",
        "Options --existing and --base cannot be used together",
      );
    }

    const worktreePath = resolveWorktreePath(
      config.worktree_dir,
      branch,
      mainRepoPath,
      config.project_name,
    );
    const fs = yield* FileSystem.FileSystem;
    const pathExists = yield* Effect.mapError(
      fs.exists(worktreePath),
      (error) =>
        commandError(
          "worktree_error",
          `Failed to inspect worktree path '${worktreePath}'`,
          error,
        ),
    );
    const creatingBranch =
      !existing && resolvedOptions.prNumber === undefined && !pathExists;
    const base =
      explicitBase || (creatingBranch ? config.base_branch : undefined);
    const pushRemote = creatingBranch ? config.push_remote : undefined;

    if (creatingBranch) {
      yield* WorktreeService.use((service) =>
        service.fetchRemotes(mainRepoPath),
      );
    }

    if (base && !pathExists) {
      const baseExists = yield* WorktreeService.use((service) =>
        service.branchExists(base, cwd),
      );
      if (!baseExists) {
        return yield* commandError(
          "base_branch_not_found",
          `Base branch '${base}' does not exist`,
        );
      }
    }

    yield* emitReporter(reporter, {
      operation: "open",
      _tag: "TargetResolved",
      worktreePath,
      branch,
      ...(base ? { base } : {}),
    });
    const sessionName = workspaceSessionName(
      yield* canonicalSessionTarget({ mainRepoPath, branch, worktreePath }),
    );
    const env = createWctEnv(
      worktreePath,
      resolved.work_dir,
      mainRepoPath,
      branch,
      config.project_name,
    );
    const workingDir = env.WCT_WORK_DIR;

    yield* emitPhase(reporter, "open", { _tag: "CreatingWorktree" });
    yield* emitReporter(reporter, {
      operation: "open",
      _tag: "AttemptStarted",
      attempt: "worktree",
    });
    const worktreeResult = yield* WorktreeService.use((service) =>
      service.createWorktree(
        worktreePath,
        branch,
        existing,
        base,
        cwd,
        pushRemote,
      ),
    );
    if (worktreeResult._tag === "PathConflict") {
      return yield* commandError(
        "worktree_error",
        worktreeResult.existingBranch
          ? `Path already exists for branch '${worktreeResult.existingBranch}', not '${branch}'`
          : `Path '${worktreePath}' already exists and is not a registered worktree for '${branch}'`,
      );
    }

    if (resolvedOptions.prNumber !== undefined) {
      const prNumber = resolvedOptions.prNumber;
      // This read-only PR observation and cache write are best effort. Keep their
      // timeout outside command supervision while retaining the operation lease.
      yield* Effect.ignore(
        Effect.gen(function* () {
          const baseRepository = yield* GitHubService.use((service) =>
            service.resolveBaseRepo(mainRepoPath),
          );
          yield* PrCacheService.use((service) =>
            service.setExplicit(mainRepoPath, branch, {
              baseRepository,
              number: prNumber,
            }),
          );
        }),
      ).pipe(Effect.provideService(CurrentWorkspaceLease, undefined));
    }

    const copy = yield* copyWorkspaceFiles({
      config,
      copyConfig: resolved.copy,
      profileName,
      projectDefinesCopy,
      created: worktreeResult._tag !== "AlreadyExists",
      mainRepoPath,
      worktreePath,
      reporter,
    });
    const { setup, warnings: setupWarnings } = yield* runWorkspaceSetup({
      setupConfig: resolved.setup,
      workingDir,
      env,
      reporter,
    });
    const { tmux, warnings: tmuxWarnings } = yield* startWorkspaceSession({
      operation: "open",
      reporter,
      sessionName,
      workingDir,
      tmuxConfig: resolved.tmux,
      env,
    });
    return {
      operation: "open",
      worktreePath,
      mainRepoPath,
      branch,
      sessionName:
        tmux.attempted && tmux.ok ? tmux.value.sessionName : sessionName,
      projectName: config.project_name,
      ...(profileName ? { profileName } : {}),
      created: worktreeResult._tag !== "AlreadyExists",
      env,
      warnings: [...setupWarnings, ...tmuxWarnings],
      attempts: {
        worktree: {
          attempted: true,
          ok: true,
          value: worktreeResult,
        },
        copy,
        setup,
        tmux,
      },
    };
  });
}

function resolveTargetImpl(
  options: ResolveWorkspaceTargetOptions = {},
): Effect.Effect<
  string,
  WctError,
  WorktreeServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const { path, branch } = options;

    if (path && branch) {
      return yield* commandError(
        "invalid_options",
        "--path and --branch are mutually exclusive",
      );
    }

    if (path) return resolve(path);

    if (branch) {
      const match = yield* WorktreeService.use((service) =>
        service.findWorktreeByBranch(branch),
      );

      if (!match) {
        return yield* commandError(
          "worktree_not_found",
          `No worktree found for branch '${branch}'`,
        );
      }

      return resolve(match.path);
    }

    return yield* Effect.try({
      try: () => process.cwd(),
      catch: (err) =>
        commandError(
          "unexpected_error",
          "Failed to resolve current working directory",
          err,
        ),
    });
  });
}

function upImpl(
  options: WorkspaceUpOptions = {},
): Effect.Effect<
  WorkspaceUpResult,
  WctError,
  WorktreeServiceApi | TmuxServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const { profile, reporter } = options;

    yield* emitPhase(reporter, "up", { _tag: "Preparing" });
    const targetPath = yield* resolveTargetImpl(options);

    const isRepo = yield* WorktreeService.use((service) =>
      service.isGitRepo(targetPath),
    );
    if (!isRepo) {
      return yield* commandError("not_git_repo", "Not a git repository");
    }
    const worktreePath = yield* WorktreeService.use((service) =>
      service.getWorktreeRoot(targetPath),
    );
    yield* emitReporter(reporter, {
      operation: "up",
      _tag: "TargetResolved",
      worktreePath,
    });

    const [mainRepoPath, branch] = yield* Effect.all([
      WorktreeService.use((service) => service.getMainRepoPath(worktreePath)),
      WorktreeService.use((service) => service.getCurrentBranch(worktreePath)),
    ]);

    if (!mainRepoPath) {
      return yield* commandError(
        "worktree_error",
        "Could not determine repository root",
      );
    }
    if (!branch) {
      return yield* commandError(
        "detached_head",
        "Could not determine current branch (detached HEAD is not supported)",
      );
    }

    const config = yield* Effect.mapError(loadConfig(mainRepoPath), (error) =>
      commandError("config_error", error.message, error),
    );
    const { config: resolved, profileName } = yield* resolveWorkspaceProfile(
      config,
      branch,
      profile,
    );

    const sessionName = workspaceSessionName(
      yield* canonicalSessionTarget({ mainRepoPath, branch, worktreePath }),
    );
    const env = createWctEnv(
      worktreePath,
      resolved.work_dir,
      mainRepoPath,
      branch,
      config.project_name,
    );
    const workingDir = env.WCT_WORK_DIR;

    const { tmux, warnings } = yield* startWorkspaceSession({
      operation: "up",
      reporter,
      sessionName,
      workingDir,
      tmuxConfig: resolved.tmux,
      env,
    });
    return {
      operation: "up",
      worktreePath,
      mainRepoPath,
      branch,
      sessionName:
        tmux.attempted && tmux.ok ? tmux.value.sessionName : sessionName,
      projectName: config.project_name,
      ...(profileName ? { profileName } : {}),
      env,
      warnings,
      attempts: { tmux },
    };
  });
}

interface ShutdownConfig {
  config: ResolvedConfig;
  env: WctEnv;
}

function prepareShutdown(worktreePath: string, profile?: string) {
  return Effect.gen(function* () {
    const [mainRepoPath, branch] = yield* Effect.all([
      WorktreeService.use((service) => service.getMainRepoPath(worktreePath)),
      WorktreeService.use((service) => service.getCurrentBranch(worktreePath)),
    ]);
    if (!mainRepoPath) {
      return yield* commandError(
        "worktree_error",
        "Could not determine repository root",
      );
    }
    const config = yield* Effect.mapError(loadConfig(mainRepoPath), (error) =>
      commandError("config_error", error.message, error),
    );
    // Detached HEAD cannot select a branch-matched profile.
    const resolved = yield* resolveWorkspaceProfile(
      config,
      branch ?? "",
      profile ?? (branch ? undefined : ""),
    );
    return {
      config: resolved.config,
      env: createWctEnv(
        worktreePath,
        resolved.config.work_dir,
        mainRepoPath,
        branch ?? "",
        config.project_name,
      ),
    } satisfies ShutdownConfig;
  });
}

function stopSession(request: ShutdownRequest, reporter?: WorkspaceReporter) {
  return Effect.gen(function* () {
    const { operation } = request;
    const target = yield* shutdownSessionTarget(request);
    const session = yield* TmuxService.use((service) =>
      service.resolveSession(target, request.session),
    );
    const sessionName = session?.name ?? workspaceSessionName(target);
    const existed = session !== null;
    if (session) {
      const id = session.id;
      if (!id)
        return yield* commandError(
          "tmux_error",
          "Verified tmux session ID is missing",
        );
      yield* emitPhase(reporter, operation, { _tag: "StoppingTmuxSession" });
      yield* TmuxService.use((service) => service.killSession(id));
    }
    yield* emitReporter(reporter, {
      operation,
      _tag: existed ? "SessionKilled" : "SessionAbsent",
      sessionName,
    });
    const kill: WorkspaceAttempt<null> = existed
      ? { attempted: true, ok: true, value: null }
      : skippedAttempt("session_absent");
    return { sessionName, existed, kill };
  });
}

function runDownScripts(
  shutdown: ShutdownConfig | undefined,
  operation: "down" | "close",
  reporter?: WorkspaceReporter,
) {
  return Effect.gen(function* () {
    const warnings: WorkspaceDownWarning[] = [];
    if (!shutdown?.config.down?.length) {
      return {
        down: skippedAttempt<CommandResult[]>(
          shutdown ? "down_not_configured" : "worktree_missing",
        ),
        warnings,
      };
    }
    yield* emitReporter(reporter, {
      operation,
      _tag: "AttemptStarted",
      attempt: "down",
    });
    const results = yield* runShellCommands(
      shutdown.config.down,
      shutdown.env.WCT_WORK_DIR,
      shutdown.env,
      {
        commandStarted: (name, current, total) =>
          Effect.gen(function* () {
            yield* emitPhase(reporter, operation, {
              _tag: "RunningDown",
              name,
            });
            yield* emitReporter(reporter, {
              operation,
              _tag: "DownCommandStarted",
              name,
              current,
              total,
            });
          }),
        commandCompleted: (result) =>
          emitReporter(reporter, {
            operation,
            _tag: "DownCommandCompleted",
            result,
          }),
      },
    );
    const failed = results.filter((result) => result._tag === "Failed");
    if (failed.length > 0) {
      const details = results
        .filter((result) => result._tag !== "Succeeded")
        .map(
          (result) =>
            `${result.name}${result._tag === "OptionalFailed" ? " (optional)" : ""}: ${result.error}`,
        )
        .join("; ");
      return yield* commandError(
        "down_failed",
        `Down scripts failed; tmux is stopped and the worktree is preserved: ${details}`,
      );
    }
    for (const result of results) {
      if (result._tag === "OptionalFailed") {
        warnings.push({
          _tag: "DownFailed",
          operation,
          name: result.name,
          optional: true,
          error: {
            code: "optional_down_failed",
            message: result.error,
          },
        });
      }
    }
    const down: WorkspaceAttempt<CommandResult[]> = {
      attempted: true,
      ok: true,
      value: results,
    };
    return { down, warnings };
  });
}

export function executeWorkspaceShutdown(
  request: ShutdownRequest,
  reporter?: WorkspaceReporter,
): Effect.Effect<
  WorkspaceDownResult | WorkspaceCloseResult,
  WctError,
  WorktreeServiceApi | TmuxServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const { operation, worktreePath } = request;
    const { sessionName, existed, kill } = yield* stopSession(
      request,
      reporter,
    );
    const { down, warnings } = yield* runDownScripts(
      request.shutdown,
      operation,
      reporter,
    );
    if (operation === "down") {
      return {
        operation,
        worktreePath,
        sessionName,
        existed,
        status: existed ? "killed" : "absent",
        attempts: { kill, down },
        warnings,
      };
    }
    const removalTarget = request.targetEvidence
      ? yield* assertWorkspaceTarget(
          { ...request.targetEvidence, session: null },
          { removalOnly: true, afterScripts: true },
        )
      : yield* inspectWorkspaceTarget(worktreePath, request.cwd);
    let removeResult = yield* removeWorkspace(
      worktreePath,
      request.force ?? false,
      request.cwd,
      reporter,
      removalTarget,
    );
    if (removeResult._tag === "BlockedByChanges" && request.retryWithForce) {
      removeResult = yield* removeWorkspace(
        worktreePath,
        true,
        request.cwd,
        reporter,
        removalTarget,
      );
    }
    return {
      operation,
      worktreePath,
      sessionName,
      existed,
      status:
        removeResult._tag === "Removed" ? "removed" : "blocked_by_changes",
      attempts: {
        kill,
        down,
        remove: { attempted: true, ok: true, value: removeResult },
      },
      warnings,
      ...(removeResult._tag === "BlockedByChanges" ? { removalTarget } : {}),
    };
  });
}

function shutdownSessionTarget(request: ShutdownRequest) {
  return Effect.gen(function* () {
    if (request.sessionTarget) return request.sessionTarget;
    if (request.shutdown) {
      const env = request.shutdown.env;
      return yield* canonicalSessionTarget({
        mainRepoPath: env.WCT_MAIN_DIR,
        branch: env.WCT_BRANCH,
        worktreePath: request.worktreePath,
      });
    }
    const mainRepoPath = yield* WorktreeService.use((service) =>
      service.getMainRepoPath(request.cwd),
    );
    if (!mainRepoPath)
      return yield* commandError(
        "worktree_error",
        "Cannot resolve repository for session shutdown",
      );
    const trees = yield* WorktreeService.use((service) =>
      service.listWorktrees(request.cwd),
    );
    const tree = trees.find(
      (tree) => resolve(tree.path) === resolve(request.worktreePath),
    );
    if (!tree)
      return yield* commandError(
        "worktree_error",
        "Cannot resolve registered Workspace for session shutdown",
      );
    return yield* canonicalSessionTarget({
      mainRepoPath,
      worktreePath: tree.path,
      branch: tree.branch,
    });
  });
}

function finishShutdown(
  request: ShutdownRequest,
  reporter?: WorkspaceReporter,
) {
  return Effect.gen(function* () {
    const sessionTarget = yield* shutdownSessionTarget(request);
    const session = yield* TmuxService.use((service) =>
      service.resolveSession(sessionTarget),
    );
    const resolved = {
      ...request,
      sessionTarget,
      session,
      targetEvidence: yield* inspectWorkspaceTarget(
        request.worktreePath,
        request.cwd ?? sessionTarget.mainRepoPath,
      ),
    };
    const { tmux, pane } = yield* loadRuntimeConfig(
      Config.all({
        tmux: Config.String("TMUX").pipe(Config.withDefault("")),
        pane: Config.String("TMUX_PANE").pipe(Config.withDefault("")),
      }),
    );
    if (tmux && pane && session) {
      const currentSession = yield* TmuxService.use(
        (service) => service.getCurrentSession,
      );
      if (currentSession === session.name || currentSession === session.id)
        return yield* runDetachedShutdown(resolved, reporter);
    }
    return yield* executeWorkspaceShutdown(
      { ...resolved, retryWithForce: false },
      reporter,
    );
  });
}

function downImpl(
  options: WorkspaceDownOptions = {},
): Effect.Effect<
  WorkspaceDownResult,
  WctError,
  WorktreeServiceApi | TmuxServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const { reporter } = options;
    yield* emitPhase(reporter, "down", { _tag: "Preparing" });
    const targetPath = yield* resolveTargetImpl(options);
    const isRepo = yield* WorktreeService.use((service) =>
      service.isGitRepo(targetPath),
    );
    if (!isRepo) {
      return yield* commandError("not_git_repo", "Not a git repository");
    }
    const worktreePath = yield* WorktreeService.use((service) =>
      service.getWorktreeRoot(targetPath),
    );
    yield* emitReporter(reporter, {
      operation: "down",
      _tag: "TargetResolved",
      worktreePath,
    });
    const shutdown = yield* prepareShutdown(worktreePath, options.profile);
    const result = yield* finishShutdown(
      { operation: "down", worktreePath, shutdown },
      reporter,
    );
    if (result.operation !== "down") {
      return yield* commandError(
        "unexpected_error",
        "Unexpected shutdown result",
      );
    }
    return result;
  });
}

function removeWorkspace(
  worktreePath: string,
  force: boolean,
  cwd?: string,
  reporter?: WorkspaceReporter,
  target?: WorkspaceTargetEvidence,
) {
  return Effect.gen(function* () {
    yield* emitPhase(reporter, "close", { _tag: "RemovingWorktree" });
    yield* emitReporter(reporter, {
      operation: "close",
      _tag: "AttemptStarted",
      attempt: "worktree",
    });
    const context = yield* Effect.context<
      WorktreeServiceApi | TmuxServiceApi | BunServices.BunServices
    >();
    return yield* WorktreeService.use((service) =>
      service.removeWorktree(
        worktreePath,
        force,
        cwd,
        target
          ? assertWorkspaceTarget(target, {
              removalOnly: true,
              afterScripts: true,
            }).pipe(Effect.asVoid, Effect.provideContext(context))
          : undefined,
      ),
    );
  });
}

function retryCloseRemovalImpl(
  previous: WorkspaceCloseResult,
  options: { cwd?: string; reporter?: WorkspaceReporter } = {},
): Effect.Effect<
  WorkspaceCloseResult,
  WctError,
  WorktreeServiceApi | TmuxServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    if (
      previous.status !== "blocked_by_changes" ||
      !previous.attempts.remove.attempted ||
      !previous.attempts.remove.ok ||
      previous.attempts.remove.value._tag !== "BlockedByChanges"
    ) {
      return yield* commandError(
        "invalid_options",
        "Removal retry requires a close result blocked by changes",
      );
    }
    const cwd = previous.removalTarget?.target.mainRepoPath ?? options.cwd;
    if (!cwd) {
      return yield* commandError(
        "worktree_error",
        "Cannot resolve repository for removal retry",
      );
    }
    const result = yield* removeWorkspace(
      previous.worktreePath,
      true,
      cwd,
      options.reporter,
      previous.removalTarget,
    );
    return {
      ...previous,
      status: result._tag === "Removed" ? "removed" : "blocked_by_changes",
      attempts: {
        ...previous.attempts,
        remove: { attempted: true, ok: true, value: result },
      },
    };
  });
}

function closeImpl(
  options: WorkspaceCloseOptions = {},
): Effect.Effect<
  WorkspaceCloseResult,
  WctError,
  WorktreeServiceApi | TmuxServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const { cwd, force = false, reporter } = options;
    yield* emitPhase(reporter, "close", { _tag: "Preparing" });
    let worktreePath = yield* resolveTargetImpl(options);

    let missing = false;
    let isRepo = yield* WorktreeService.use((service) =>
      service.isGitRepo(worktreePath),
    );
    if (!isRepo) {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs
        .exists(worktreePath)
        .pipe(
          Effect.mapError((error) =>
            commandError(
              "worktree_error",
              "Failed to inspect worktree path",
              error,
            ),
          ),
        );
      if (!exists) {
        missing = true;
        // A deleted directory can still have a registered worktree. Git's
        // targeted remove also cleans up that record, without pruning others.
        const worktrees = yield* WorktreeService.use((service) =>
          service.listWorktrees(cwd),
        );
        isRepo = worktrees.some(
          (worktree) =>
            !worktree.isBare && resolve(worktree.path) === worktreePath,
        );
      }
    }
    if (!isRepo) {
      return yield* commandError("not_git_repo", "Not a git repository");
    }

    if (!missing) {
      worktreePath = yield* WorktreeService.use((service) =>
        service.getWorktreeRoot(worktreePath),
      );
    }
    yield* emitReporter(reporter, {
      operation: "close",
      _tag: "TargetResolved",
      worktreePath,
    });
    if (missing && options.profile) {
      // Resolve the Main Repository from the caller because the checkout is gone.
      const mainRepoPath = yield* WorktreeService.use((service) =>
        service.getMainRepoPath(cwd),
      );
      if (!mainRepoPath) {
        return yield* commandError(
          "worktree_error",
          "Could not determine repository root",
        );
      }
      const config = yield* Effect.mapError(loadConfig(mainRepoPath), (error) =>
        commandError("config_error", error.message, error),
      );
      yield* resolveWorkspaceProfile(config, "", options.profile);
    }
    const shutdown = missing
      ? undefined
      : yield* prepareShutdown(worktreePath, options.profile);
    const result = yield* finishShutdown(
      {
        operation: "close",
        worktreePath,
        shutdown,
        force,
        retryWithForce: options.retryWithForce,
        cwd: cwd ?? shutdown?.env.WCT_MAIN_DIR,
      },
      reporter,
    );
    if (result.operation !== "close") {
      return yield* commandError(
        "unexpected_error",
        "Unexpected shutdown result",
      );
    }
    return result;
  });
}

function acquireWorkspace(
  target: { mainRepoPath: string; branch: string },
  operation: WorkspaceOperation,
  reporter?: WorkspaceReporter,
) {
  return Effect.gen(function* () {
    const coordination = yield* WorkspaceCoordinationService;
    let waiting = false;
    const acquire = coordination
      .acquire(target, {
        onWait: Effect.gen(function* () {
          if (waiting) return;
          waiting = true;
          yield* emitPhase(reporter, operation, { _tag: "Waiting", ...target });
        }),
      })
      .pipe(
        Effect.mapError((error) =>
          commandError(
            "workspace_coordination_error",
            `${error.message} Use wct operations inspect <branch> --repo <main-repository> for target '${target.branch}' in '${target.mainRepoPath}'.`,
          ),
        ),
      );
    if (!reporter?.waitSignal) return yield* acquire;
    const signal = reporter.waitSignal;
    const cancelled = Effect.callback<never, WctError>((resume) => {
      const cancel = () =>
        resume(
          Effect.fail(
            commandError(
              "invalid_options",
              "Cancelled waiting for Workspace ownership",
            ),
          ),
        );
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      return Effect.sync(() => signal.removeEventListener("abort", cancel));
    });
    return yield* Effect.raceFirst(acquire, cancelled);
  });
}

function coordinatedTarget<A, E, R>(
  operation: WorkspaceOperation,
  options: WorkspaceDownOptions & { cwd?: string },
  run: (
    target: WorkspaceTargetEvidence,
    path: string,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const path = yield* resolveTargetImpl(options);
      const initial =
        options.confirmedTarget ??
        (yield* inspectWorkspaceTarget(path, options.cwd));
      if (options.expectedTarget) {
        const expected = yield* canonicalSessionTarget(options.expectedTarget);
        if (JSON.stringify(expected) !== JSON.stringify(initial.target))
          return yield* commandError(
            "worktree_error",
            "Selected Workspace changed; confirm the action again",
          );
      }
      if (options.expectedSession !== undefined) {
        const expected = options.expectedSession;
        const actual = initial.session;
        if (
          (expected === null) !== (actual === null) ||
          (expected &&
            actual &&
            (expected.name !== actual.name ||
              expected.id !== actual.id ||
              expected.server !== actual.server))
        )
          return yield* commandError(
            "tmux_error",
            "Confirmed Workspace Session changed; confirm the action again",
          );
      }
      if (resolve(path) !== resolve(initial.target.worktreePath)) {
        // A caller in a subdirectory is resolved to the retained checkout below.
        const root = yield* WorktreeService.use((service) =>
          service.getWorktreeRoot(path),
        );
        const canonical = yield* canonicalSessionTarget({
          ...initial.target,
          worktreePath: root,
        });
        if (canonical.worktreePath !== initial.target.worktreePath)
          return yield* commandError(
            "worktree_error",
            "Confirmed Workspace path changed; confirm the action again",
          );
      }
      const lease = yield* acquireWorkspace(
        { ...initial.target, branch: initial.coordinationBranch },
        operation,
        options.reporter,
      );
      return yield* Effect.gen(function* () {
        const current = yield* assertWorkspaceTarget(initial);
        if (options.confirmation)
          yield* assertWorkspaceConfirmation(options.confirmation, current);
        return yield* run(current, current.target.worktreePath);
      }).pipe(Effect.provideService(CurrentWorkspaceLease, lease));
    }),
  );
}

function coordinatedOpen(options: WorkspaceOpenOptions) {
  return Effect.scoped(
    Effect.gen(function* () {
      if (options.pr && options.branch)
        return yield* commandError(
          "invalid_options",
          "Cannot use --pr together with a branch argument",
        );
      if (options.pr && options.base)
        return yield* commandError(
          "invalid_options",
          "Cannot use --pr together with --base",
        );
      if (options.pr && options.existing)
        return yield* commandError(
          "invalid_options",
          "Cannot use --pr together with --existing",
        );
      // PR lookup is read-only. Fetching and adding a fork remote happen under custody.
      let branch = options.branch;
      if (options.pr) {
        const number = parsePrArg(options.pr);
        if (number === null)
          return yield* commandError(
            "pr_error",
            `Invalid --pr value: '${options.pr}'`,
          );
        const installed = yield* GitHubService.use(
          (service) => service.isGhInstalled,
        );
        if (!installed)
          return yield* commandError(
            "gh_not_installed",
            "GitHub CLI (gh) is not installed.\n\nInstall it from https://cli.github.com/ and run 'gh auth login'",
          );
        branch = (yield* GitHubService.use((service) =>
          service.resolvePr(number, options.cwd),
        )).branch;
      }
      if (!branch)
        return yield* commandError("missing_branch_arg", "Missing branch name");
      const main = yield* WorktreeService.use((service) =>
        service.getMainRepoPath(options.cwd),
      );
      if (!main)
        return yield* commandError("not_git_repo", "Not a git repository");
      const target = yield* canonicalSessionTarget({
        mainRepoPath: main,
        branch,
        worktreePath: main,
      });
      const lease = yield* acquireWorkspace(target, "open", options.reporter);
      // Preserve the invoking checkout's HEAD when no base was supplied.
      const currentMain = yield* WorktreeService.use((service) =>
        service.getMainRepoPath(options.cwd),
      );
      if (
        !currentMain ||
        (yield* canonicalSessionTarget({
          ...target,
          mainRepoPath: currentMain,
        })).mainRepoPath !== target.mainRepoPath
      )
        return yield* commandError(
          "worktree_error",
          "Main Repository changed while waiting; retry Open",
        );
      return yield* openImpl(options, branch).pipe(
        Effect.provideService(CurrentWorkspaceLease, lease),
      );
    }),
  );
}

function coordinatedRemoval(
  previous: WorkspaceCloseResult,
  options: { cwd?: string; reporter?: WorkspaceReporter } = {},
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const target = previous.removalTarget;
      if (!target)
        return yield* commandError(
          "invalid_options",
          "Removal retry requires retained canonical target evidence; inspect and confirm Close again",
        );
      const lease = yield* acquireWorkspace(
        { ...target.target, branch: target.coordinationBranch },
        "close",
        options.reporter,
      );
      return yield* Effect.gen(function* () {
        yield* assertWorkspaceTarget(target, { removalOnly: true });
        return yield* retryCloseRemovalImpl(previous, {
          ...options,
          cwd: options.cwd ?? target.target.mainRepoPath,
        });
      }).pipe(Effect.provideService(CurrentWorkspaceLease, lease));
    }),
  );
}

type WorkspaceServiceDependencies =
  | BunServices.BunServices
  | WorktreeServiceApi
  | TmuxServiceApi
  | SetupServiceApi
  | GitHubServiceApi
  | PrCacheServiceApi
  | WorkspaceCoordinationServiceApi;

export type WorkspaceServiceImplementation = ServiceImplementation<
  WorkspaceService,
  WorkspaceServiceDependencies
>;

export const liveWorkspaceService: WorkspaceServiceImplementation = {
  open: coordinatedOpen,
  up: (options = {}) =>
    coordinatedTarget("up", options, (_target, path) =>
      upImpl({
        ...options,
        path,
        branch: undefined,
      }),
    ),
  down: (options = {}) =>
    coordinatedTarget("down", options, (_target, path) =>
      downImpl({
        ...options,
        path,
        branch: undefined,
      }),
    ),
  close: (options = {}) =>
    coordinatedTarget("close", options, (target, path) =>
      closeImpl({
        ...options,
        path,
        branch: undefined,
        cwd: options.cwd ?? target.target.mainRepoPath,
      }),
    ),
  retryCloseRemoval: coordinatedRemoval,
};

export function makeWorkspaceService(
  implementation: WorkspaceServiceImplementation = liveWorkspaceService,
) {
  return Effect.map(Effect.context<WorkspaceServiceDependencies>(), (context) =>
    bindServiceContext<WorkspaceService, WorkspaceServiceDependencies>(
      implementation,
      Context.pick(
        ...bunServiceKeys,
        WorktreeService,
        TmuxService,
        SetupService,
        GitHubService,
        PrCacheService,
        WorkspaceCoordinationService,
      )(context),
    ),
  );
}
